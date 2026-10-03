import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EgressPolicy, MoveTicket, WarmHost, WarmMove } from '@imp/api';
import { EgressPolicySchema } from '@imp/api';
import { ORPCError } from '@orpc/server';
import type { ApiAudit } from '../audit/api-audit';
import { writeChangedBlocks } from '../backup/write-changed-blocks';
import type { Broker } from '../broker/broker-service';
import { buildCheckpointId } from '../checkpoints/checkpoint-service';
import { createCheckpoint } from '../db/checkpoints';
import { writeMovedBoots } from '../db/cold-boots';
import { createImage, findImageByDigest, findImageByName } from '../db/images';
import {
  SlotTakenError,
  findImpById,
  findImpByName,
  isSlotFree,
  listImps,
  updateImpCommitted,
} from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { writeMovedLeases } from '../db/leases';
import type { ImpDatabase } from '../db/open-database';
import type { EgressService } from '../egress/egress-service';
import type { Imps } from '../imps/imp-service';
import { readErrorMessage } from '../read-error-message';
import { findColdBootReason, readSnapshotMeta, writeSnapshotMeta } from '../sleep/snapshot-meta';
import type { SnapshotMeta } from '../sleep/snapshot-meta';
import type { HostIdentity } from '../sleep/vm-identity';
import { writeVmIdentity } from '../sleep/vm-identity';
import { buildSystemDrivePath } from '../storage/data-layout';
import type { DiskBudget } from '../storage/disk-budget';
import { CheckpointIdTakenError } from '../storage/storage-backend';
import type { StorageBackend } from '../storage/storage-backend';
import type { StorageGate } from '../storage/storage-gate';
import {
  FileEndSchema,
  MOVE_FRAMES,
  MoveFileSchema,
  createDataHash,
  createFrameReader,
  readDataPayload,
  readJsonPayload,
} from './move-frames';
import type { FrameReader, MoveFile } from './move-frames';
import {
  MOVE_FINISH_HEADER,
  MOVE_PART_HEADER,
  MOVE_PATHS,
  MoveHeaderSchema,
  MoveOfferSchema,
} from './move-header';
import type { MoveHeader, MovedLease } from './move-header';
import { PART_WAIT_MS, createPartPipe } from './move-parts';
import type { PartPipe } from './move-parts';
import {
  buildReceipt,
  buildSecretHash,
  createTicket,
  isSameHash,
  readTicketHeader,
} from './move-tickets';
import type { ParsedTicket, ReceiptBody } from './move-tickets';
import type { PeerRanges } from './peer-address';
import { findWarmMismatches } from './warm-facts';

// a stream must start this soon after its ticket; the commit is good this
// long after the receipt (docs/architecture/moves.md#tickets)
const STREAM_WINDOW_MS = 10 * 60 * 1000;
const COMMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const ID_ATTEMPTS = 5;

interface MoveTicketRow {
  readonly id: string;
  readonly secret_sha256: string;
  readonly name: string;
  readonly bytes: number;
  readonly imp_id: string | null;
  readonly stream_by: number;
  readonly stream_used_at: number | null;
  readonly receipt: string | null;
  readonly commit_until: number | null;
  readonly committed_at: number | null;

  // a warm move's slot
  readonly slot: number | null;
}

export interface MoveReceiver {
  // with `warm`, a warm move's: checked against this host, its slot kept
  readonly issueTicket: (name: string, bytes: number, warm?: WarmMove) => Promise<MoveTicket>;

  // a fresh commit ticket for an imp staged `receiving`
  readonly reissueTicket: (name: string) => Promise<MoveTicket>;

  // `/move/*`, from `peer`, the connected socket's address
  readonly handle: (request: Request, peer: string | null) => Promise<Response>;

  // at start: a stream a crash cut short leaves its staged imp; it goes
  readonly recover: () => Promise<void>;
}

export interface MoveReceiverDeps {
  readonly db: ImpDatabase;
  readonly dataDir: string;
  readonly storage: Pick<
    StorageBackend,
    | 'kind'
    | 'resolveImpPaths'
    | 'createImpDisk'
    | 'createCheckpoint'
    | 'createImage'
    | 'receiveMoveSnapshots'
  >;
  readonly storageGate: Pick<StorageGate, 'join'>;
  readonly diskBudget: Pick<DiskBudget, 'requireRoom' | 'withRoom'>;
  readonly imps: Pick<Imps, 'createImp' | 'destroyImp' | 'lockImpId'>;
  readonly grants: Pick<Broker, 'addGrant' | 'listSecrets'>;
  readonly egress: Pick<EgressService, 'writeAnswers'>;
  readonly ranges: PeerRanges;

  // what loads a memory snapshot here, and the facts a warm move must match
  readonly readIdentity: () => HostIdentity;
  readonly readWarmHost: () => WarmHost;

  // this host's base URL as a source reaches it
  readonly readPeerUrl: () => Promise<string>;

  // after a commit: the tailnet-names pass, which gives the imp its name here
  readonly onCommitted: (name: string) => void;
  readonly audit: Pick<ApiAudit, 'record'>;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

// an HTTP status as the audit log names a refusal
const STATUS_CODES: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  410: 'GONE',
  413: 'PAYLOAD_TOO_LARGE',
};

function readStatusCode(status: number): string {
  return STATUS_CODES[status] ?? 'INTERNAL_SERVER_ERROR';
}

class MoveRequestError extends Error {
  override name = 'MoveRequestError';

  readonly status: number;

  constructor(status: number, message: string) {
    super(message);

    this.status = status;
  }
}

// the data bytes a stream carried; past its ticket's count, it stops
interface ByteCounter {
  readonly add: (bytes: number) => void;
}

function createByteCounter(limit: number): ByteCounter {
  let bytes = 0;

  return {
    add: (more) => {
      bytes += more;

      if (bytes > limit) {
        throw new MoveRequestError(413, 'the stream is longer than its ticket allows');
      }
    },
  };
}

type ReceivedFile = ReceiptBody['files'][number];

interface CheckedTicket {
  readonly row: MoveTicketRow;
  readonly ticket: ParsedTicket;
}

// a response's status and JSON body, which more than one request may send
interface Reply {
  readonly status: number;
  readonly body: unknown;
}

interface ReceiveSession {
  readonly pipe: PartPipe;
  nextPart: number;

  // by impd's clock: a part later than PART_WAIT_MS after this ends it
  lastPartAt: number;

  // the receipt, or the error, once the stream is read
  readonly result: Promise<Reply>;
}

export function createMoveReceiver(deps: MoveReceiverDeps): MoveReceiver {
  const tempDir = join(deps.dataDir, 'moves');

  const sessions = new Map<string, ReceiveSession>();

  const findTicketRow = (id: string): Promise<MoveTicketRow | undefined> =>
    deps.db.selectFrom('move_tickets').selectAll().where('id', '=', id).executeTakeFirst();

  // the ticket in the header, checked against its stored hash
  const requireTicket = async (request: Request): Promise<CheckedTicket> => {
    const ticket = readTicketHeader(request);

    if (ticket === null) {
      throw new MoveRequestError(401, 'no move ticket in the Authorization header');
    }

    const row = await findTicketRow(ticket.id);

    if (row === undefined || !isSameHash(row.secret_sha256, buildSecretHash(ticket.secret))) {
      throw new MoveRequestError(401, 'unknown move ticket');
    }

    return { row, ticket };
  };

  const writeTicketRow = async (
    name: string,
    bytes: number,
    fields: Partial<MoveTicketRow>,
    db: ImpDatabase = deps.db,
  ) => {
    const created = createTicket();
    const now = deps.now();

    await db
      .insertInto('move_tickets')
      .values({
        id: created.id,
        secret_sha256: buildSecretHash(created.secret),
        name,
        bytes,
        imp_id: fields.imp_id ?? null,
        issued_at: now,
        stream_by: now + STREAM_WINDOW_MS,
        stream_used_at: fields.stream_used_at ?? null,
        receipt: fields.receipt ?? null,
        commit_until: fields.commit_until ?? null,
        committed_at: null,
        slot: fields.slot ?? null,
      })
      .execute();

    return {
      ticket: created.text,
      expiresAt: new Date(now + STREAM_WINDOW_MS),
      peerUrl: await deps.readPeerUrl(),
    };
  };

  // Each file into a sparse temp file, then over the disk block by block, so
  // the checkpoints share every block they did on the source
  const readFileInto = async (
    reader: FrameReader,
    expected: MoveFile['kind'],
    path: string,
    count: ByteCounter,
  ): Promise<{ sha256: string; bytes: number; file: MoveFile }> => {
    const start = await reader.readFrame();

    if (start?.type !== MOVE_FRAMES.file) {
      throw new MoveRequestError(400, `the stream has no ${expected} file`);
    }

    const file = MoveFileSchema.parse(readJsonPayload(start.payload));

    if (file.kind !== expected) {
      throw new MoveRequestError(400, `the stream sent ${file.kind} where ${expected} goes`);
    }

    const handle = await open(path, 'w');

    const hash = createDataHash();
    let bytes = 0;

    try {
      await handle.truncate(file.sizeBytes);

      for (;;) {
        const frame = await reader.readFrame();

        if (frame === null) {
          throw new MoveRequestError(400, 'the stream ended inside a file');
        }

        if (frame.type === MOVE_FRAMES.fileEnd) {
          const sha256 = FileEndSchema.parse(readJsonPayload(frame.payload)).sha256;

          if (!isSameHash(sha256, hash.digest('hex'))) {
            throw new MoveRequestError(400, `${expected}: the sha256 does not match the data`);
          }

          return { sha256, bytes, file };
        }

        if (frame.type !== MOVE_FRAMES.data) {
          throw new MoveRequestError(400, `an unexpected frame ${String(frame.type)} in a file`);
        }

        const data = readDataInFile(frame.payload, file.sizeBytes);

        await handle.write(data.data, 0, data.data.length, data.offset);

        hash.update(frame.payload);

        bytes += data.data.length;

        count.add(data.data.length);
      }
    } finally {
      await handle.close();
    }
  };

  const createCheckpointDisk = async (impId: string) => {
    for (let attempt = 1; ; attempt += 1) {
      const id = buildCheckpointId();

      try {
        return { id, sizeBytes: await deps.storage.createCheckpoint(impId, id) };
      } catch (error) {
        if (!(error instanceof CheckpointIdTakenError) || attempt >= ID_ATTEMPTS) {
          throw error;
        }
      }
    }
  };

  // The image by the source's digest when this host has it, else from the
  // stream under the digest of what arrived (docs/guides/hosts.md#moves)
  const requireImage = async (
    reader: FrameReader,
    header: MoveHeader,
    count: ByteCounter,
    tempBase: string,
  ): Promise<{ readonly name: string; readonly files: readonly ReceivedFile[] }> => {
    const existing = await findImageByDigest(deps.db, header.image.digest);

    if (existing !== undefined) {
      return { name: existing.name, files: [] };
    }

    if (!header.image.isIncluded) {
      throw new MoveRequestError(409, `this host has no image ${header.image.digest}`);
    }

    const temps = { rootfs: `${tempBase}.rootfs`, config: `${tempBase}.config` };

    try {
      const rootfs = await readFileInto(reader, 'image-rootfs', temps.rootfs, count);
      const config = await readFileInto(reader, 'image-config', temps.config, count);

      const files: ReceivedFile[] = [
        { kind: 'image-rootfs', sha256: rootfs.sha256, bytes: rootfs.bytes },
        { kind: 'image-config', sha256: config.sha256, bytes: config.bytes },
      ];

      const digest = buildReceivedDigest(rootfs.sha256, config.sha256);

      const known = await findImageByDigest(deps.db, digest);

      if (known !== undefined) {
        return { name: known.name, files };
      }

      await deps.storageGate.join(() =>
        deps.storage.createImage(digest, async (dir) => {
          await copyFile(temps.config, join(dir, 'config.json'));

          writeFileSync(join(dir, 'rootfs.ext4'), '');

          await writeChangedBlocks(temps.rootfs, join(dir, 'rootfs.ext4'));
        }),
      );

      const taken = await findImageByName(deps.db, header.image.name);

      const hex = digest.replace(/^sha256:/, '').slice(0, 8);

      const name =
        taken === undefined ? header.image.name : `${header.image.name.slice(0, 22)}-${hex}`;

      await createImage(deps.db, {
        name,
        ref: header.image.ref,
        digest,
        sizeBytes: header.image.sizeBytes,
        source: header.image.source,
        sourceImp: header.image.sourceImp,
      });

      return { name, files };
    } finally {
      rmSync(temps.rootfs, { force: true });
      rmSync(temps.config, { force: true });
    }
  };

  // Only a grant of a secret this host has by that name; the rest are
  // logged, never made
  const createGrants = async (header: MoveHeader): Promise<void> => {
    const secrets = await deps.grants.listSecrets();

    const known = new Set(secrets.map((secret) => secret.name));

    for (const secretName of header.imp.grants) {
      if (!known.has(secretName)) {
        deps.log(
          `impd: move: ${header.imp.name}: grant ${secretName} dropped: no such secret here`,
        );

        continue;
      }

      try {
        await deps.grants.addGrant(header.imp.name, secretName);
      } catch (error) {
        deps.log(
          `impd: move: ${header.imp.name}: grant ${secretName} not kept: ${readErrorMessage(error)}`,
        );
      }
    }
  };

  // ZFS to ZFS: each stream into `zfs recv`, then the checkpoints' rows
  const writeStreams = async (
    impId: string,
    header: MoveHeader,
    reader: FrameReader,
    count: ByteCounter,
    onFile: (file: ReceivedFile) => void,
  ): Promise<void> => {
    const streams = checkStreams(header);

    if (deps.storage.kind !== 'zfs') {
      throw new MoveRequestError(409, 'this host is not on ZFS: it takes a move as files only');
    }

    const steps = streams.map((stream) => ({
      isCheckpoint: stream.checkpoint !== null,
      dataset: stream.dataset,
      base: stream.base,
    }));

    const received = await deps.storage.receiveMoveSnapshots(
      impId,
      steps,
      (index) =>
        readStreamFile(reader, index, count, (got) => {
          onFile({ kind: 'zfs-stream', index, sha256: got.sha256, bytes: got.bytes });
        }),
      buildCheckpointId,
    );

    const ordered = streams.filter((stream) => stream.checkpoint !== null);

    for (const [index, made] of received.entries()) {
      const checkpoint = header.checkpoints[ordered[index]?.checkpoint ?? -1];

      if (checkpoint === undefined) {
        throw new MoveRequestError(400, 'a stream names no checkpoint of the header');
      }

      await createCheckpoint(deps.db, {
        id: made.id,
        impId,
        label: checkpoint.label,
        sizeBytes: made.sizeBytes,
        createdAt: checkpoint.createdAt,
        diskBytes: checkpoint.diskBytes,
      });
    }
  };

  const readStream = async (
    stream: ReadableStream<Uint8Array>,
    row: MoveTicketRow,
    secret: string,
  ): Promise<Reply> => {
    const reader = createFrameReader(stream);

    const first = await reader.readFrame();

    if (first?.type !== MOVE_FRAMES.header) {
      throw new MoveRequestError(400, 'the stream does not start with its header');
    }

    const header = MoveHeaderSchema.parse(readJsonPayload(first.payload));

    // each lease ends this long after now: the time it had left when the
    // source built the header, however long the disk then takes
    const headerAt = deps.now();

    if (header.imp.name !== row.name) {
      throw new MoveRequestError(403, `the ticket is for ${row.name}, not ${header.imp.name}`);
    }

    if ((await findImpById(deps.db, header.imp.id)) !== undefined) {
      throw new MoveRequestError(409, `this host has an imp with id ${header.imp.id}`);
    }

    // the ticket's checks again, on what the stream itself says
    if (header.warm !== null) {
      requireWarmMove(header.warm.move);
      requireOwnDrivePath(header.warm);

      if (header.warm.move.slot !== row.slot) {
        throw new MoveRequestError(409, `the ticket keeps slot ${String(row.slot)}, not this one`);
      }
    } else if (row.slot !== null) {
      throw new MoveRequestError(409, 'the ticket is for a warm move, and the stream is cold');
    }

    await deps.db
      .updateTable('move_tickets')
      .set({ imp_id: header.imp.id })
      .where('id', '=', row.id)
      .execute();

    const count = createByteCounter(row.bytes);
    const files: ReceivedFile[] = [];

    mkdirSync(tempDir, { recursive: true, mode: 0o700 });

    const temp = join(tempDir, `${row.id}.part`);

    const writeDisk = async (impId: string): Promise<void> => {
      if (header.streams !== null) {
        await writeStreams(impId, header, reader, count, (file) => {
          files.push(file);
        });

        return;
      }

      await deps.storage.createImpDisk(impId, { kind: 'empty' });

      const disk = deps.storage.resolveImpPaths(impId).disk;

      for (const [index, checkpoint] of header.checkpoints.entries()) {
        const got = await readFileInto(reader, 'checkpoint', temp, count);

        await writeChangedBlocks(temp, disk);

        const made = await createCheckpointDisk(impId);

        await createCheckpoint(deps.db, {
          id: made.id,
          impId,
          label: checkpoint.label,
          sizeBytes: made.sizeBytes,
          createdAt: checkpoint.createdAt,
          diskBytes: checkpoint.diskBytes,
        });

        files.push({ kind: 'checkpoint', index, sha256: got.sha256, bytes: got.bytes });
      }

      const got = await readFileInto(reader, 'disk', temp, count);

      await writeChangedBlocks(temp, disk);

      files.push({ kind: 'disk', sha256: got.sha256, bytes: got.bytes });
    };

    try {
      // files take twice the data: each sits in the temp file, then on the
      // disk; streams go straight into `zfs recv`, and only the image's files
      // pass through a temp file
      const imageBytes = header.image.isIncluded ? header.image.sizeBytes : 0;
      const room = header.streams === null ? 2 * row.bytes : row.bytes + imageBytes;

      await deps.diskBudget.withRoom(room, async () => {
        const image = await requireImage(reader, header, count, temp);

        files.push(...image.files);

        await deps.imps.createImp({
          id: header.imp.id,
          name: header.imp.name,
          image: image.name,
          vcpus: header.imp.vcpus,
          memoryMib: header.imp.memoryMib,
          maxMemoryMib: header.imp.maxMemoryMib,
          httpPort: header.imp.httpPort,
          diskMib: Math.ceil(header.imp.diskBytes / (1024 * 1024)),
          policy: resolvePolicy(header, deps.log),
          cpuLimit: header.imp.cpu.limit,
          cpuWeight: header.imp.cpu.weight,
          start: false,
          moveState: 'receiving',
          isIdentityResetPending: header.imp.isIdentityResetPending,
          isDiskGrowPending: header.imp.isDiskGrowPending,
          ...(header.warm !== null && { slot: header.warm.move.slot }),
          prepareDisk: writeDisk,
        });

        // the staged imp's own rows: they go with it if the stream fails
        await writeMovedBoots(deps.db, header.imp.id, header.imp.coldBoots, deps.now());
        await writeLeases(header, headerAt);

        if (header.warm !== null) {
          await writeWarmFiles(header.imp.id, header.warm, reader, count, temp, (file) => {
            files.push(file);
          });
        }
      });

      const end = await reader.readFrame();

      if (end?.type !== MOVE_FRAMES.end) {
        throw new MoveRequestError(400, 'the stream does not end with END');
      }
    } catch (error) {
      await removeStaged(header.imp.name, header.imp.id);

      throw error;
    } finally {
      rmSync(temp, { force: true });
    }

    await createGrants(header);

    const receipt = buildReceipt(
      { ticketId: row.id, name: header.imp.name, impId: header.imp.id, files },
      secret,
    );

    await deps.db
      .updateTable('move_tickets')
      .set({ receipt: JSON.stringify(receipt), commit_until: deps.now() + COMMIT_WINDOW_MS })
      .where('id', '=', row.id)
      .execute();

    deps.log(`impd: move: ${header.imp.name}: received, waiting for the commit`);

    return { status: 200, body: receipt };
  };

  // Firecracker reopens the drive by the path the snapshot names: only this
  // host's own path for that sha256, whether the drive came along or not
  const requireOwnDrivePath = (warm: NonNullable<MoveHeader['warm']>): void => {
    const path = buildSystemDrivePath(deps.dataDir, warm.meta.systemDrive);
    const named = [warm.meta.systemDrivePath, warm.vm?.systemDrivePath];

    if (named.some((given) => given !== undefined && given !== path)) {
      throw new MoveRequestError(400, `the snapshot's drive is not at ${path}`);
    }
  };

  // the facts of a warm move this host does not match, as a refusal
  const requireWarmMove = (move: WarmMove): void => {
    const mismatches = findWarmMismatches(move, deps.readWarmHost());

    if (mismatches.length > 0) {
      throw new MoveRequestError(409, `this host cannot load the memory: ${mismatches.join('; ')}`);
    }
  };

  // A warm move's files, after the disk: the system drive when this host
  // lacks it, then vmstate and mem straight into the snapshot directory,
  // which loads nothing without meta.json. meta.json goes last.
  const writeWarmFiles = async (
    impId: string,
    warm: NonNullable<MoveHeader['warm']>,
    reader: FrameReader,
    count: ByteCounter,
    temp: string,
    onFile: (file: ReceivedFile) => void,
  ): Promise<void> => {
    const paths = deps.storage.resolveImpPaths(impId);

    if (warm.isDriveIncluded) {
      const got = await readFileInto(reader, 'system-drive', temp, count);

      await writeSystemDrive(temp, warm.meta);

      onFile({ kind: 'system-drive', sha256: got.sha256, bytes: got.bytes });
    }

    mkdirSync(paths.snapshotDir, { recursive: true });

    for (const kind of ['vmstate', 'mem'] as const) {
      const path = kind === 'vmstate' ? paths.vmstate : paths.memFile;

      const got = await readFileInto(reader, kind, path, count);

      onFile({ kind, sha256: got.sha256, bytes: got.bytes });
    }

    if (warm.vm !== null) {
      writeVmIdentity(paths, warm.vm);
    }

    for (const answer of warm.answers) {
      await deps.egress.writeAnswers(warm.move.slot, answer.names, [answer]);
    }

    // the wake's own check, before the record that lets a wake load it
    const reason = findColdBootReason(warm.meta, deps.readIdentity());

    if (reason !== null) {
      throw new MoveRequestError(409, `the memory snapshot cannot load here: ${reason}`);
    }

    writeSnapshotMeta(paths, warm.meta);
  };

  // A drive lands under its own sha256, which other snapshots trust: what
  // arrived must hash to the name the snapshot gives it
  const writeSystemDrive = async (temp: string, meta: Readonly<SnapshotMeta>) => {
    const path = buildSystemDrivePath(deps.dataDir, meta.systemDrive);

    const sha256 = await readFileSha256(temp);

    if (!isSameHash(sha256, meta.systemDrive)) {
      throw new MoveRequestError(400, 'the system drive does not match its sha256');
    }

    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      renameSync(temp, path);
    }
  };

  // The leases as of the header, less any that ended while the disk came.
  // An older source sends none: the imp arrives unleased.
  const writeLeases = async (header: MoveHeader, headerAt: number): Promise<void> => {
    if (header.imp.leases === undefined) {
      deps.log(
        `impd: move: ${header.imp.name}: the source's impd predates moving leases; it arrives with none`,
      );

      return;
    }

    const now = deps.now();

    const live = header.imp.leases.flatMap((lease) => {
      const until = readMovedLeaseEnd(lease, headerAt);

      if (until !== null && until.getTime() <= now) {
        return [];
      }

      return [
        {
          principal: lease.principal,
          label: lease.label,
          display: lease.display,
          until,
          createdAt: lease.createdAt,
        },
      ];
    });

    await writeMovedLeases(deps.db, header.imp.id, live);
  };

  // only an imp a move staged here, never a live one of the same name
  const removeStaged = async (name: string, impId: string): Promise<void> => {
    const staged = await findImpById(deps.db, impId);

    if (staged?.moveState !== 'receiving') {
      return;
    }

    await deps.imps.destroyImp(name, { isMove: true }).catch((error: unknown) => {
      deps.log(`impd: move: ${name}: a failed receive left the imp: ${readErrorMessage(error)}`);
    });
  };

  const handleOffer = async (request: Request): Promise<Response> => {
    await requireTicket(request);

    const body: unknown = await request.json();

    const offer = MoveOfferSchema.parse(body);

    const existing = await findImageByDigest(deps.db, offer.imageDigest);

    const needsSystemDrive =
      offer.systemDrive !== undefined &&
      !existsSync(buildSystemDrivePath(deps.dataDir, offer.systemDrive));

    return Response.json({
      needsImage: existing === undefined,
      needsSystemDrive,
      storage: deps.storage.kind,
      keepsMaxMemory: true,
      keepsLeases: true,
    });
  };

  // a failed read fails the pipe, so a part waiting on it answers too
  const readStreamOrFail = async (
    pipe: PartPipe,
    row: MoveTicketRow,
    secret: string,
  ): Promise<Reply> => {
    try {
      return await readStream(pipe.stream, row, secret);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));

      pipe.fail(failure);

      // the ticket streams once, so a refused header or a failed stream
      // gives up its slot now, abort or not
      await deps.db
        .updateTable('move_tickets')
        .set({ slot: null })
        .where('id', '=', row.id)
        .execute();

      return readErrorReply(error, deps.log);
    }
  };

  // the first part uses the ticket up and starts the stream
  const openSession = async (row: MoveTicketRow, secret: string): Promise<ReceiveSession> => {
    if (deps.now() > row.stream_by) {
      throw new MoveRequestError(410, 'the move ticket expired before its stream started');
    }

    // single use: only the first stream marks it
    const marked = await deps.db
      .updateTable('move_tickets')
      .set({ stream_used_at: deps.now() })
      .where('id', '=', row.id)
      .where('stream_used_at', 'is', null)
      .executeTakeFirst();

    if (marked.numUpdatedRows === 0n) {
      throw new MoveRequestError(409, 'the move ticket was used for a stream already');
    }

    const pipe = createPartPipe();
    const result = readStreamOrFail(pipe, row, secret);
    const session: ReceiveSession = { pipe, nextPart: 0, lastPartAt: deps.now(), result };

    sessions.set(row.id, session);

    // a stream lasts as long as its parts keep coming; once it is read, a
    // source that never sends its finish leaves the session this long
    void removeSessionLater(row.id, result);

    return session;
  };

  const removeSessionLater = async (id: string, result: Promise<Reply>): Promise<void> => {
    await result;

    setTimeout(() => {
      sessions.delete(id);
    }, PART_WAIT_MS).unref();
  };

  // A part's body goes into the stream; the finish waits for the receipt.
  const handleReceive = async (request: Request): Promise<Response> => {
    const checked = await requireTicket(request);

    const row = checked.row;
    const part = Number(request.headers.get(MOVE_PART_HEADER) ?? '0');
    const existing = sessions.get(row.id);

    if (request.headers.get(MOVE_FINISH_HEADER) === '1') {
      if (existing === undefined) {
        throw new MoveRequestError(409, 'no stream to finish for this ticket');
      }

      existing.pipe.end();

      const reply = await existing.result;

      sessions.delete(row.id);

      return Response.json(reply.body, { status: reply.status });
    }

    const session = part === 0 ? await openSession(row, checked.ticket.secret) : existing;

    if (session?.nextPart !== part || request.body === null) {
      throw new MoveRequestError(409, `part ${String(part)} is out of order`);
    }

    if (part > 0 && deps.now() - session.lastPartAt > PART_WAIT_MS) {
      session.pipe.fail(
        new MoveRequestError(410, 'the next part of the move stream came too late'),
      );

      const reply = await session.result;

      return Response.json(reply.body, { status: reply.status });
    }

    session.nextPart += 1;
    session.lastPartAt = deps.now();

    try {
      await session.pipe.push(request.body);

      // the gap runs from the end of one part to the start of the next
      session.lastPartAt = deps.now();
    } catch {
      const reply = await session.result;

      return Response.json(reply.body, { status: reply.status });
    }

    return Response.json({ part }, { status: 202 });
  };

  // The commit's two writes, the mark and the ticket, as one
  const writeCommit = async (imp: ImpRecord, row: MoveTicketRow): Promise<void> => {
    const isWarm = row.slot !== null;

    // a warm imp commits sleeping, only on a snapshot that loads
    if (isWarm && readSnapshotMeta(deps.storage.resolveImpPaths(imp.id)) === null) {
      throw new MoveRequestError(409, 'the received memory snapshot is not complete');
    }

    await updateImpCommitted(deps.db, imp.id, deps.now(), isWarm);

    deps.log(`impd: move: ${row.name}: committed; it lives here now`);
    deps.onCommitted(row.name);
  };

  // Idempotent, under the imp's lock, so a commit and an abort never cross:
  // a commit the target made already answers the same
  const handleCommit = async (request: Request): Promise<Response> => {
    const checked = await requireTicket(request);

    const impId = checked.row.imp_id;

    if (checked.row.receipt === null || impId === null) {
      throw new MoveRequestError(409, 'nothing to commit: no receipt for this ticket');
    }

    return deps.imps.lockImpId(impId, async (imp) => {
      const row = await findTicketRow(checked.row.id);

      const settled = row === undefined ? 'none' : readSettled(row, imp);

      if (settled === 'committed') {
        return Response.json({ isCommitted: true });
      }

      if (row === undefined || imp === undefined || settled === 'none') {
        throw new MoveRequestError(409, 'nothing to commit: the received copy is gone');
      }

      if (row.commit_until !== null && deps.now() > row.commit_until) {
        throw new MoveRequestError(410, 'the commit window ended; reissue the ticket');
      }

      await writeCommit(imp, row);

      return Response.json({ isCommitted: true });
    });
  };

  // Refused once committed: the source must destroy its copy instead. The
  // tickets go under the lock, so no commit follows; the staged imp after.
  const handleAbort = async (request: Request): Promise<Response> => {
    const checked = await requireTicket(request);

    const impId = checked.row.imp_id;

    // a stream still open stops reading now
    sessions.get(checked.row.id)?.pipe.fail(new Error('the source aborted the move'));

    const removeTickets = () =>
      deps.db
        .deleteFrom('move_tickets')
        .where((eb) =>
          eb.or([
            eb('id', '=', checked.row.id),
            ...(impId === null ? [] : [eb('imp_id', '=', impId)]),
          ]),
        )
        .execute();

    if (impId === null) {
      await removeTickets();

      return Response.json({ isCommitted: false });
    }

    const settled = await deps.imps.lockImpId(impId, async (imp) => {
      const row = await findTicketRow(checked.row.id);

      const found = row === undefined ? 'none' : readSettled(row, imp);

      if (found !== 'committed') {
        await removeTickets();
      }

      return found;
    });

    if (settled === 'committed') {
      return Response.json({ isCommitted: true }, { status: 409 });
    }

    await removeStaged(checked.row.name, impId);

    deps.log(`impd: move: ${checked.row.name}: aborted by the source`);

    return Response.json({ isCommitted: false });
  };

  const handleRoute = async (request: Request, peer: string | null): Promise<Response> => {
    const route = ROUTES[new URL(request.url).pathname];

    if (route === undefined || request.method !== 'POST') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    if (peer === null || !deps.ranges.isAllowed(peer)) {
      return Response.json({ error: 'moves come only over the tailnet' }, { status: 403 });
    }

    try {
      return await route(request);
    } catch (error) {
      const reply = readErrorReply(error, deps.log);

      return Response.json(reply.body, { status: reply.status });
    }
  };

  const ROUTES: Readonly<Record<string, (request: Request) => Promise<Response>>> = {
    [MOVE_PATHS.offer]: handleOffer,
    [MOVE_PATHS.receive]: handleReceive,
    [MOVE_PATHS.commit]: handleCommit,
    [MOVE_PATHS.abort]: handleAbort,
  };

  return {
    issueTicket: async (name, bytes, warm) => {
      const taken = await findImpByName(deps.db, name);

      if (taken !== undefined) {
        throw new ORPCError('CONFLICT', {
          message: `this host has an imp named ${name}`,
          data: { kind: 'imp' as const, name },
        });
      }

      await deps.diskBudget.requireRoom(2 * bytes);

      if (warm === undefined) {
        return writeTicketRow(name, bytes, {});
      }

      const mismatches = findWarmMismatches(warm, deps.readWarmHost());

      if (mismatches.length > 0) {
        throw new ORPCError('PRECONDITION_FAILED', {
          message: `this host cannot load ${name}'s memory: ${mismatches.join('; ')}`,
        });
      }

      // in one transaction, so two tickets never keep the same slot
      return deps.db.transaction().execute(async (trx) => {
        if (!(await isSlotFree(trx, warm.slot, deps.now()))) {
          throw new ORPCError('CONFLICT', {
            message: `slot ${String(warm.slot)}, which ${name}'s memory needs, is taken here`,
          });
        }

        return writeTicketRow(name, bytes, { slot: warm.slot }, trx);
      });
    },

    reissueTicket: async (name) => {
      const imp = await findImpByName(deps.db, name);

      const staged =
        imp?.moveState === 'receiving'
          ? await deps.db
              .selectFrom('move_tickets')
              .selectAll()
              .where('imp_id', '=', imp.id)
              .where('receipt', 'is not', null)
              .executeTakeFirst()
          : undefined;

      if (imp === undefined || staged === undefined) {
        throw new ORPCError('NOT_FOUND', {
          message: `no imp named ${name} waits for a commit here`,
          data: { kind: 'imp' as const, name },
        });
      }

      // a warm move's slot too: the commit reads warm from it
      return writeTicketRow(name, 0, {
        imp_id: imp.id,
        stream_used_at: deps.now(),
        receipt: staged.receipt,
        commit_until: deps.now() + COMMIT_WINDOW_MS,
        slot: staged.slot,
      });
    },

    handle: async (request, peer) => {
      const startedAt = deps.now();

      const path = new URL(request.url).pathname;

      const ticket = readTicketHeader(request);

      // before the route: an abort removes the ticket
      const row = ticket === null ? undefined : await findTicketRow(ticket.id);

      const response = await handleRoute(request, peer);

      const failure = response.ok ? null : new ORPCError(readStatusCode(response.status));

      // as a call on /rpc, by the peer: `move.receive` and the rest
      deps.audit.record(
        {
          procedure: `move.${path.slice(path.lastIndexOf('/') + 1)}`,
          actor: { kind: 'tailnet', name: `move from ${peer ?? 'unknown'}` },
          impName: row?.name ?? null,
          startedAt,
        },
        failure,
      );

      return response;
    },

    recover: async () => {
      const rows = await deps.db.selectFrom('move_tickets').selectAll().execute();

      for (const row of rows) {
        const isCutShort = row.stream_used_at !== null && row.receipt === null;
        const isUnused = row.stream_used_at === null && deps.now() > row.stream_by;

        // a commit answers a retry until its window ends, then it is history
        const isSpent =
          row.committed_at !== null && row.commit_until !== null && deps.now() > row.commit_until;

        if (isCutShort && row.imp_id !== null) {
          await removeStaged(row.name, row.imp_id);
        }

        if (isCutShort || isUnused || isSpent) {
          await deps.db.deleteFrom('move_tickets').where('id', '=', row.id).execute();
        }
      }

      // an abort that removed the tickets, then stopped before the imp
      const left = await deps.db.selectFrom('move_tickets').select('imp_id').execute();

      const ticketed = new Set(left.map((row) => row.imp_id));

      for (const imp of await listImps(deps.db)) {
        if (imp.moveState === 'receiving' && !ticketed.has(imp.id)) {
          await removeStaged(imp.name, imp.id);
        }
      }

      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function readErrorReply(error: unknown, log: (message: string) => void): Reply {
  const status = readErrorStatus(error);

  if (status === 500) {
    log(`impd: move: ${readErrorMessage(error)}`);
  }

  return { status, body: { error: readErrorMessage(error) } };
}

// a slot another imp took since the ticket is a conflict, not a fault
function readErrorStatus(error: unknown): number {
  if (error instanceof MoveRequestError) {
    return error.status;
  }

  return error instanceof SlotTakenError ? 409 : 500;
}

function readDataInFile(payload: Uint8Array, size: number): ReturnType<typeof readDataPayload> {
  const data = readDataPayload(payload);

  if (data.offset + data.data.length > size) {
    throw new MoveRequestError(400, 'a DATA frame past the end of its file');
  }

  return data;
}

function readMovedLeaseEnd(lease: Readonly<MovedLease>, headerAt: number): Date | null {
  return lease.remainingMs === null ? null : new Date(headerAt + lease.remainingMs);
}

// a policy this impd cannot read comes as none, never more open
function resolvePolicy(header: MoveHeader, log: (message: string) => void): EgressPolicy {
  const parsed = EgressPolicySchema.safeParse(header.imp.egress);

  if (parsed.success) {
    return parsed.data;
  }

  log(`impd: move: ${header.imp.name}: unknown egress policy; received as none`);

  return { mode: 'none', allow: [] };
}

// the header's streams name each checkpoint once; the storage checks their
// order, the disk's last
function checkStreams(header: MoveHeader): NonNullable<MoveHeader['streams']> {
  const streams = header.streams ?? [];

  const named = streams.flatMap((stream) =>
    stream.checkpoint === null ? [] : [stream.checkpoint],
  );

  const isEach =
    named.length === header.checkpoints.length &&
    new Set(named).size === named.length &&
    named.every((checkpoint) => checkpoint < header.checkpoints.length);

  if (!isEach) {
    throw new MoveRequestError(400, 'the streams do not name each checkpoint once');
  }

  return streams;
}

interface StreamFile {
  readonly sha256: string;
  readonly bytes: number;
}

// One stream of the move as bytes: FILE, DATA at running offsets, FILE_END.
// `zfs recv` commits at the stream's end record, not at EOF, so the last
// DATA frame waits until FILE_END's sum matches.
function readStreamFile(
  reader: FrameReader,
  index: number,
  count: ByteCounter,
  onEnd: (file: StreamFile) => void,
): ReadableStream<Uint8Array> {
  const hash = createDataHash();

  const state: { isStarted: boolean; offset: number; held: Uint8Array | null } = {
    isStarted: false,
    offset: 0,
    held: null,
  };

  const requireStart = async () => {
    const start = await reader.readFrame();

    const file =
      start?.type === MOVE_FRAMES.file
        ? MoveFileSchema.parse(readJsonPayload(start.payload))
        : null;

    if (file?.kind !== 'zfs-stream' || file.index !== index) {
      throw new MoveRequestError(400, `the stream has no ZFS stream ${String(index)}`);
    }

    state.isStarted = true;
  };

  // the next DATA frame's bytes, or null once FILE_END's sum holds
  const readNext = async (): Promise<Uint8Array | null> => {
    const frame = await reader.readFrame();

    if (frame?.type === MOVE_FRAMES.fileEnd) {
      const sha256 = FileEndSchema.parse(readJsonPayload(frame.payload)).sha256;

      if (!isSameHash(sha256, hash.digest('hex'))) {
        throw new MoveRequestError(400, `ZFS stream ${String(index)}: the sha256 does not match`);
      }

      onEnd({ sha256, bytes: state.offset });

      return null;
    }

    if (frame?.type !== MOVE_FRAMES.data) {
      throw new MoveRequestError(400, `ZFS stream ${String(index)} ended early`);
    }

    const data = readDataPayload(frame.payload);

    if (data.offset !== state.offset) {
      throw new MoveRequestError(400, `ZFS stream ${String(index)}: a DATA frame out of order`);
    }

    hash.update(frame.payload);

    state.offset += data.data.length;

    count.add(data.data.length);

    return data.data;
  };

  return new ReadableStream<Uint8Array>({
    // a pull that enqueues nothing is not called again, so the first one
    // reads on until it has a frame to pass
    pull: async (controller) => {
      if (!state.isStarted) {
        await requireStart();
      }

      for (;;) {
        const next = await readNext();

        const held = state.held;

        state.held = next;

        if (held !== null) {
          controller.enqueue(held);
        }

        if (next === null) {
          controller.close();

          return;
        }

        if (held !== null) {
          return;
        }
      }
    },
  });
}

// the sha256 of a whole file, as content-addressed paths name it
async function readFileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of Bun.file(path).stream()) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

// a received image's digest: its two files' stream sums, as they arrived
function buildReceivedDigest(rootfsSha256: string, configSha256: string): string {
  const hash = createHash('sha256').update(`rootfs ${rootfsSha256}\nconfig ${configSha256}\n`);

  return `sha256:${hash.digest('hex')}`;
}

// Where a ticket's imp stands. Committed once the ticket says so, or once
// the imp lives here unmarked: a mark gone means the commit landed.
function readSettled(
  row: MoveTicketRow,
  imp: ImpRecord | undefined,
): 'committed' | 'staged' | 'none' {
  if (row.committed_at !== null || (imp !== undefined && imp.moveState === null)) {
    return 'committed';
  }

  return imp?.moveState === 'receiving' ? 'staged' : 'none';
}
