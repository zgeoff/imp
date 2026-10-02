import { mkdirSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { EgressPolicy, MoveTicket } from '@imp/api';
import { EgressPolicySchema } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { writeChangedBlocks } from '../backup/write-changed-blocks';
import type { Broker } from '../broker/broker-service';
import { buildCheckpointId } from '../checkpoints/checkpoint-service';
import { createCheckpoint } from '../db/checkpoints';
import { createImage, findImageByDigest, findImageByName } from '../db/images';
import { findImpById, findImpByName, updateImpMove } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { Imps } from '../imps/imp-service';
import { readErrorMessage } from '../read-error-message';
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
import type { MoveHeader } from './move-header';
import { createPartPipe } from './move-parts';
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
}

export interface MoveReceiver {
  readonly issueTicket: (name: string, bytes: number) => Promise<MoveTicket>;

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
    'resolveImpPaths' | 'createImpDisk' | 'createCheckpoint' | 'createImage'
  >;
  readonly storageGate: Pick<StorageGate, 'join'>;
  readonly diskBudget: Pick<DiskBudget, 'requireRoom' | 'withRoom'>;
  readonly imps: Pick<Imps, 'createImp' | 'destroyImp'>;
  readonly grants: Pick<Broker, 'addGrant'>;
  readonly ranges: PeerRanges;

  // this host's base URL as a source reaches it
  readonly readPeerUrl: () => Promise<string>;

  // after a commit: the tailnet-names pass, which gives the imp its name here
  readonly onCommitted: (name: string) => void;
  readonly now: () => number;
  readonly log: (message: string) => void;
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

  const writeTicketRow = async (name: string, bytes: number, fields: Partial<MoveTicketRow>) => {
    const created = createTicket();
    const now = deps.now();

    await deps.db
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

  // the image by digest, or from the stream when the source sent it
  const requireImage = async (
    reader: FrameReader,
    header: MoveHeader,
    count: ByteCounter,
  ): Promise<{ readonly name: string; readonly files: readonly ReceivedFile[] }> => {
    const existing = await findImageByDigest(deps.db, header.image.digest);

    if (existing !== undefined) {
      return { name: existing.name, files: [] };
    }

    if (!header.image.isIncluded) {
      throw new MoveRequestError(409, `this host has no image ${header.image.digest}`);
    }

    const files: ReceivedFile[] = [];

    await deps.storageGate.join(() =>
      deps.storage.createImage(header.image.digest, async (dir) => {
        const rootfs = await readFileInto(reader, 'image-rootfs', join(dir, 'rootfs.ext4'), count);
        const config = await readFileInto(reader, 'image-config', join(dir, 'config.json'), count);

        files.push(
          { kind: 'image-rootfs', sha256: rootfs.sha256, bytes: rootfs.bytes },
          { kind: 'image-config', sha256: config.sha256, bytes: config.bytes },
        );
      }),
    );

    const taken = await findImageByName(deps.db, header.image.name);

    const hex = header.image.digest.replace(/^sha256:/, '').slice(0, 8);

    const name =
      taken === undefined ? header.image.name : `${header.image.name.slice(0, 22)}-${hex}`;

    await createImage(deps.db, {
      name,
      ref: header.image.ref,
      digest: header.image.digest,
      sizeBytes: header.image.sizeBytes,
    });

    return { name, files };
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

    if (header.imp.name !== row.name) {
      throw new MoveRequestError(403, `the ticket is for ${row.name}, not ${header.imp.name}`);
    }

    if ((await findImpById(deps.db, header.imp.id)) !== undefined) {
      throw new MoveRequestError(409, `this host has an imp with id ${header.imp.id}`);
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
      // twice the data: each file sits in the temp file, then on the disk
      await deps.diskBudget.withRoom(2 * row.bytes, async () => {
        const image = await requireImage(reader, header, count);

        files.push(...image.files);

        await deps.imps.createImp({
          id: header.imp.id,
          name: header.imp.name,
          image: image.name,
          vcpus: header.imp.vcpus,
          memoryMib: header.imp.memoryMib,
          httpPort: header.imp.httpPort,
          diskMib: Math.ceil(header.imp.diskBytes / (1024 * 1024)),
          policy: resolvePolicy(header, deps.log),
          cpuLimit: header.imp.cpu.limit,
          cpuWeight: header.imp.cpu.weight,
          start: false,
          moveState: 'receiving',
          prepareDisk: writeDisk,
        });
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

    for (const secretName of header.imp.grants) {
      await deps.grants.addGrant(header.imp.name, secretName).catch((error: unknown) => {
        deps.log(
          `impd: move: ${header.imp.name}: grant ${secretName} not kept: ${readErrorMessage(error)}`,
        );
      });
    }

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

    return Response.json({ needsImage: existing === undefined });
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
    const session: ReceiveSession = { pipe, nextPart: 0, result };

    sessions.set(row.id, session);

    // a source that never sends its finish leaves the session this long
    setTimeout(() => {
      sessions.delete(row.id);
    }, STREAM_WINDOW_MS).unref();

    return session;
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

    session.nextPart += 1;

    try {
      await session.pipe.push(request.body);
    } catch {
      const reply = await session.result;

      return Response.json(reply.body, { status: reply.status });
    }

    return Response.json({ part }, { status: 202 });
  };

  // idempotent: a commit the target made already answers the same
  const handleCommit = async (request: Request): Promise<Response> => {
    const checked = await requireTicket(request);

    const row = checked.row;

    if (row.committed_at !== null) {
      return Response.json({ isCommitted: true });
    }

    if (row.receipt === null || row.imp_id === null) {
      throw new MoveRequestError(409, 'nothing to commit: no receipt for this ticket');
    }

    if (row.commit_until !== null && deps.now() > row.commit_until) {
      throw new MoveRequestError(410, 'the commit window ended; reissue the ticket');
    }

    const imp = await findImpById(deps.db, row.imp_id);

    if (imp?.moveState === 'receiving') {
      await updateImpMove(deps.db, imp.id, null);
    }

    await deps.db
      .updateTable('move_tickets')
      .set({ committed_at: deps.now() })
      .where('imp_id', '=', row.imp_id)
      .execute();

    deps.log(`impd: move: ${row.name}: committed; it lives here now`);
    deps.onCommitted(row.name);

    return Response.json({ isCommitted: true });
  };

  // refused once committed: the source must destroy its copy instead
  const handleAbort = async (request: Request): Promise<Response> => {
    const checked = await requireTicket(request);

    const row = checked.row;

    if (row.committed_at !== null) {
      return Response.json({ isCommitted: true }, { status: 409 });
    }

    // a stream still open stops reading now
    sessions.get(row.id)?.pipe.fail(new Error('the source aborted the move'));

    if (row.imp_id !== null) {
      await removeStaged(row.name, row.imp_id);

      await deps.db.deleteFrom('move_tickets').where('imp_id', '=', row.imp_id).execute();
    }

    await deps.db.deleteFrom('move_tickets').where('id', '=', row.id).execute();

    deps.log(`impd: move: ${row.name}: aborted by the source`);

    return Response.json({ isCommitted: false });
  };

  const ROUTES: Readonly<Record<string, (request: Request) => Promise<Response>>> = {
    [MOVE_PATHS.offer]: handleOffer,
    [MOVE_PATHS.receive]: handleReceive,
    [MOVE_PATHS.commit]: handleCommit,
    [MOVE_PATHS.abort]: handleAbort,
  };

  return {
    issueTicket: async (name, bytes) => {
      const taken = await findImpByName(deps.db, name);

      if (taken !== undefined) {
        throw new ORPCError('CONFLICT', {
          message: `this host has an imp named ${name}`,
          data: { kind: 'imp' as const, name },
        });
      }

      await deps.diskBudget.requireRoom(2 * bytes);

      return writeTicketRow(name, bytes, {});
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

      return writeTicketRow(name, 0, {
        imp_id: imp.id,
        stream_used_at: deps.now(),
        receipt: staged.receipt,
        commit_until: deps.now() + COMMIT_WINDOW_MS,
      });
    },

    handle: async (request, peer) => {
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

      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function readErrorReply(error: unknown, log: (message: string) => void): Reply {
  const status = error instanceof MoveRequestError ? error.status : 500;

  if (status === 500) {
    log(`impd: move: ${readErrorMessage(error)}`);
  }

  return { status, body: { error: readErrorMessage(error) } };
}

function readDataInFile(payload: Uint8Array, size: number): ReturnType<typeof readDataPayload> {
  const data = readDataPayload(payload);

  if (data.offset + data.data.length > size) {
    throw new MoveRequestError(400, 'a DATA frame past the end of its file');
  }

  return data;
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
