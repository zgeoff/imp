import type { MovePlan, MoveStatus, WarmHost, WarmMove } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { buildInvalidStateError, buildNotFoundError } from '../api-errors';
import type { Broker } from '../broker/broker-service';
import type { Config } from '../config';
import { listCheckpoints } from '../db/checkpoints';
import { listColdBoots } from '../db/cold-boots';
import { findImageById } from '../db/images';
import { findImpById, findImpByName, listImps, updateImpMove } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { listNetworkMembers } from '../db/networks';
import type { ImpDatabase } from '../db/open-database';
import type { EgressService } from '../egress/egress-service';
import type { Imps } from '../imps/imp-service';
import { deriveSlotAddress } from '../net/addressing';
import { readTapMac } from '../net/tap-devices';
import type { StreamedCommand } from '../process/run-stream';
import { readErrorMessage } from '../read-error-message';
import { readSnapshotMeta } from '../sleep/snapshot-meta';
import type { SnapshotMeta } from '../sleep/snapshot-meta';
import { readVmIdentity } from '../sleep/vm-identity';
import { buildImagePaths } from '../storage/data-layout';
import type { MoveMode, StorageBackend } from '../storage/storage-backend';
import {
  MOVE_FRAMES,
  countDataBytes,
  encodeCommand,
  encodeFile,
  encodeJsonFrame,
} from './move-frames';
import type { MoveFile } from './move-frames';
import {
  MOVE_FINISH_HEADER,
  MOVE_PART_HEADER,
  MOVE_PATHS,
  MoveCommitReplySchema,
  MoveOfferReplySchema,
} from './move-header';
import type { MoveHeader } from './move-header';
import { sendInParts } from './move-parts';
import { ReceiptSchema, buildTicketHeader, parseTicket, readReceipt } from './move-tickets';
import type { ReadonlyReceiptBody, ReceiptBody } from './move-tickets';
import { readPeerUrlAddress } from './peer-address';
import type { PeerRanges } from './peer-address';
import { buildWarmMove, findWarmMismatches } from './warm-facts';

export interface MoveSender {
  readonly prepare: (name: string, options: PrepareOptions) => Promise<MovePlan>;
  readonly send: (name: string, to: string, ticket: string) => Promise<MoveStatus>;
  readonly readStatus: (name: string) => Promise<MoveStatus>;
  readonly resume: (name: string, ticket: string | undefined) => Promise<MoveStatus>;
  readonly abort: (name: string) => Promise<MoveStatus>;

  // at start: a send a crash cut short aborts; a verified copy commits
  readonly recover: () => Promise<void>;
}

interface PrepareOptions {
  readonly stop: boolean;
  readonly targetStorage: 'xfs' | 'zfs';

  // the target's facts, for a warm move; null from an older CLI or target
  readonly target: WarmHost | null;
}

export interface MoveSenderDeps {
  readonly config: Pick<Config, 'subnet'>;
  readonly db: ImpDatabase;
  readonly dataDir: string;
  readonly storage: Pick<StorageBackend, 'kind' | 'openMoveSource' | 'resolveImpPaths'>;
  readonly imps: Pick<Imps, 'lockImp' | 'haltImp' | 'destroyImp'>;
  readonly grants: Pick<Broker, 'listGrants'>;
  readonly egress: Pick<EgressService, 'readPolicy' | 'readAnswers'>;
  readonly ranges: PeerRanges;

  // this host's facts, as a target of a warm move would read them
  readonly readWarmHost: () => WarmHost;

  // a tap's MAC now, or null for no tap; /sys by default
  readonly readTapMac?: (tap: string) => string | null;

  // after the receipt: the tailnet-names pass, which drops this host's name
  readonly releaseName: () => Promise<void>;
  readonly fetch?: (request: Request) => Promise<Response>;

  // the most a part carries; MOVE_PART_BYTES, but small in tests
  readonly partBytes?: number;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

// A send running here: its bytes so far, and how it ended
interface SendTask {
  readonly abort: AbortController;
  done: Promise<void>;
  sentBytes: number;
  totalBytes: number;
  error: string | null;
  isDone: boolean;
}

// a request to the target: the ticket header always, and these besides
interface PeerRequest {
  readonly body?: string | ReadableStream<Uint8Array>;
  readonly duplex?: 'half';
  readonly signal?: AbortSignal;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

// One piece of the stream after the header: a file, or a command's output
type StreamPart =
  | { readonly kind: 'file'; readonly path: string; readonly file: MoveFile }
  | { readonly kind: 'command'; readonly open: () => StreamedCommand; readonly file: MoveFile };

interface OpenedParts {
  readonly parts: readonly StreamPart[];
  readonly streams: MoveHeader['streams'];

  // what `zfs send` says its streams take; null for files
  readonly estimateBytes: number | null;
  readonly close: () => Promise<void>;
}

// `zfs send -nP` estimates: the ticket allows this much more
const ESTIMATE_SLACK = 1.1;
const ESTIMATE_SLACK_BYTES = 64 * 1024 * 1024;

type SentFile = ReceiptBody['files'][number];

// where a send goes, with its ticket, how it carries the disk, and whether
// the memory goes too
interface SendTarget {
  readonly peer: string;
  readonly ticket: string;
  readonly mode: MoveMode;
  readonly isWarm: boolean;
}

// a warm send's memory snapshot, and whether the target needs its drive
interface WarmParts {
  readonly meta: SnapshotMeta;
  readonly isDriveIncluded: boolean;
}

// what a running send reports as it goes
interface SendProgress {
  readonly signal: AbortSignal;
  readonly onData: (bytes: number) => void;
}

async function requireOk(response: Response, what: string): Promise<unknown> {
  const body = await readJsonBody(response);

  if (!response.ok) {
    const error =
      body !== null && typeof body === 'object' && 'error' in body ? String(body.error) : '';

    throw new Error(`${what}: the target answered ${String(response.status)} ${error}`.trim());
  }

  return body;
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();

    return body;
  } catch {
    return null;
  }
}

// the receipt must name this imp and repeat every sha256 the stream sent
function checkReceiptFiles(
  body: ReadonlyReceiptBody,
  imp: Readonly<ImpRecord>,
  sent: readonly Readonly<SentFile>[],
): void {
  const same =
    body.impId === imp.id &&
    body.name === imp.name &&
    body.files.length === sent.length &&
    body.files.every(
      (file, index) =>
        file.kind === sent[index]?.kind &&
        file.index === sent[index].index &&
        file.sha256 === sent[index].sha256 &&
        file.bytes === sent[index].bytes,
    );

  if (!same) {
    throw new Error('the receipt does not match what was sent');
  }
}

// The stream: the header, each file's frames, END. `onFile` gets each
// file's sha256 as it ends, for the receipt to repeat.
async function* encodeStream(
  header: Readonly<MoveHeader>,
  parts: readonly StreamPart[],
  onData: (bytes: number) => void,
  onFile: (file: SentFile) => void,
): AsyncGenerator<Uint8Array, void, undefined> {
  yield encodeJsonFrame(MOVE_FRAMES.header, header);

  for (const part of parts) {
    let bytes = 0;

    const count = (more: number) => {
      bytes += more;

      onData(more);
    };

    const onSum = (sha256: string) => {
      onFile({
        kind: part.file.kind,
        ...(part.file.index !== undefined && { index: part.file.index }),
        sha256,
        bytes,
      });
    };

    yield* part.kind === 'file'
      ? encodeFile(part.path, part.file, count, onSum)
      : encodeCommand(part.open, part.file, count, onSum);
  }

  yield encodeJsonFrame(MOVE_FRAMES.end, {});
}

// a public imp's credential and DNS record belong to this host's domain
function buildPublicError(name: string) {
  return new ORPCError('PRECONDITION_FAILED', {
    message: `${name} is public: run imp unexpose ${name} first, and imp expose on the target after the move`,
  });
}

export function createMoveSender(deps: MoveSenderDeps): MoveSender {
  const fetchPeer = deps.fetch ?? ((request: Request) => fetch(request));

  const tasks = new Map<string, SendTask>();

  // the last result per imp id, once its task and its row are gone
  const finished = new Map<string, { readonly error: string | null; readonly isDone: boolean }>();

  const findSendRow = (impId: string) =>
    deps.db.selectFrom('move_sends').selectAll().where('imp_id', '=', impId).executeTakeFirst();

  const requireImp = async (name: string): Promise<ImpRecord> => {
    const imp = await findImpByName(deps.db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return imp;
  };

  // a sleeping imp's snapshot record, which a warm send carries
  const requireMeta = (imp: ImpRecord): SnapshotMeta => {
    const meta = readSnapshotMeta(deps.storage.resolveImpPaths(imp.id));

    if (meta === null) {
      throw new Error(`${imp.name} has no memory snapshot to move`);
    }

    return meta;
  };

  // What a send carries after the header, in order: the image (when asked),
  // then each checkpoint oldest first and the disk, as files or as streams
  const openParts = async (
    imp: ImpRecord,
    mode: MoveMode,
    isImageIncluded: boolean,
    warm: WarmParts | null,
  ): Promise<OpenedParts> => {
    const opened = await openDiskParts(imp, mode, isImageIncluded);

    if (warm === null) {
      return opened;
    }

    // after the disk: the drive the snapshot reopens, then its two files
    const paths = deps.storage.resolveImpPaths(imp.id);

    const memory: StreamPart[] = [
      ...(warm.isDriveIncluded && warm.meta.systemDrivePath !== undefined
        ? [
            {
              kind: 'file' as const,
              path: warm.meta.systemDrivePath,
              file: { kind: 'system-drive' as const, sizeBytes: 0 },
            },
          ]
        : []),
      { kind: 'file', path: paths.vmstate, file: { kind: 'vmstate', sizeBytes: 0 } },
      { kind: 'file', path: paths.memFile, file: { kind: 'mem', sizeBytes: 0 } },
    ];

    return { ...opened, parts: [...opened.parts, ...memory] };
  };

  const openDiskParts = async (
    imp: ImpRecord,
    mode: MoveMode,
    isImageIncluded: boolean,
  ): Promise<OpenedParts> => {
    const image = await findImageById(deps.db, imp.imageId);

    if (image === undefined) {
      throw new Error(`${imp.name} has no image row`);
    }

    const listed = await listCheckpoints(deps.db, imp.id);

    const checkpoints = listed.toReversed();
    const imagePaths = buildImagePaths(deps.dataDir, image.digest);

    const parts: StreamPart[] = isImageIncluded
      ? [
          { kind: 'file', path: imagePaths.rootfs, file: { kind: 'image-rootfs', sizeBytes: 0 } },
          { kind: 'file', path: imagePaths.config, file: { kind: 'image-config', sizeBytes: 0 } },
        ]
      : [];

    const ids = checkpoints.map((checkpoint) => checkpoint.id);

    const source = await deps.storage.openMoveSource(imp.id, ids, mode);

    if (source.kind === 'files') {
      for (const [index, path] of source.checkpointPaths.entries()) {
        parts.push({ kind: 'file', path, file: { kind: 'checkpoint', index, sizeBytes: 0 } });
      }

      parts.push({ kind: 'file', path: source.diskPath, file: { kind: 'disk', sizeBytes: 0 } });

      return { parts, streams: null, estimateBytes: null, close: source.close };
    }

    const streams = source.steps.map((step) => ({
      checkpoint: step.checkpointId === null ? null : ids.indexOf(step.checkpointId),
      dataset: step.dataset,
      base: step.base,
    }));

    for (const [index, step] of source.steps.entries()) {
      parts.push({
        kind: 'command',
        open: step.open,
        file: { kind: 'zfs-stream', index, sizeBytes: 0 },
      });
    }

    const estimateBytes = source.steps.reduce((sum, step) => sum + step.estimateBytes, 0);

    return { parts, streams, estimateBytes, close: source.close };
  };

  // A close that fails leaves the move snapshot to the GC: logged, so it
  // never hides the error the send itself ended with
  const removeParts = async (opened: OpenedParts): Promise<void> => {
    try {
      await opened.close();
    } catch (error) {
      deps.log(`impd: move: closing the source's parts failed: ${readErrorMessage(error)}`);
    }
  };

  // the bytes a send carries: the files' data, and the streams' estimate
  // with room to spare
  const countBytes = async (
    imp: ImpRecord,
    mode: MoveMode,
    meta: SnapshotMeta | null,
  ): Promise<number> => {
    const warm = meta === null ? null : { meta, isDriveIncluded: true };

    const opened = await openParts(imp, mode, true, warm);

    try {
      let bytes = 0;

      for (const part of opened.parts) {
        if (part.kind === 'file') {
          bytes += await countDataBytes(part.path);
        }
      }

      if (opened.estimateBytes !== null) {
        bytes += Math.ceil(opened.estimateBytes * ESTIMATE_SLACK) + ESTIMATE_SLACK_BYTES;
      }

      return bytes;
    } finally {
      await removeParts(opened);
    }
  };

  // a warm send's part of the header: what the target checks, the snapshot's
  // record and vm.json, and a box imp's resolved addresses
  const buildWarmHeader = async (
    imp: ImpRecord,
    warm: WarmParts,
  ): Promise<NonNullable<MoveHeader['warm']>> => {
    const egress = await deps.egress.readPolicy(imp.name);

    return {
      move: buildWarmMove(imp.slot, egress.mode, warm.meta, deps.readWarmHost()),
      meta: warm.meta,
      vm: readVmIdentity(deps.storage.resolveImpPaths(imp.id)),
      isDriveIncluded: warm.isDriveIncluded,
      answers: egress.mode === 'box' ? deps.egress.readAnswers(imp.slot) : [],
    };
  };

  const buildHeader = async (
    imp: ImpRecord,
    isImageIncluded: boolean,
    streams: MoveHeader['streams'],
    warm: WarmParts | null,
  ): Promise<MoveHeader> => {
    const image = await findImageById(deps.db, imp.imageId);

    if (image === undefined) {
      throw new Error(`${imp.name} has no image row`);
    }

    const listed = await listCheckpoints(deps.db, imp.id);

    const checkpoints = listed.toReversed();

    const egress = await deps.egress.readPolicy(imp.name);
    const grants = await deps.grants.listGrants(imp.name);

    return {
      version: 1,
      imp: {
        id: imp.id,
        name: imp.name,
        vcpus: imp.vcpus,
        memoryMib: imp.memoryMib,
        httpPort: imp.httpPort,
        diskBytes: imp.diskBytes,
        cpu: imp.cpu,
        egress: { mode: egress.mode, allow: [...egress.allow] },
        grants,
        isIdentityResetPending: imp.isIdentityResetPending,
        isDiskGrowPending: imp.isDiskGrowPending,
        coldBoots: await listColdBoots(deps.db, imp.id),
      },
      image: {
        name: image.name,
        ref: image.ref,
        digest: image.digest,
        sizeBytes: image.sizeBytes,
        source: image.source,
        sourceImp: image.sourceImp,
        isIncluded: isImageIncluded,
      },
      checkpoints: checkpoints.map((checkpoint) => ({
        label: checkpoint.label,
        createdAt: checkpoint.createdAt,
        diskBytes: checkpoint.diskBytes,
      })),
      streams,
      warm: warm === null ? null : await buildWarmHeader(imp, warm),
    };
  };

  const sendToPeer = (
    peer: string,
    path: string,
    ticket: string,
    init: PeerRequest = {},
  ): Promise<Response> => {
    const { extraHeaders, ...rest } = init;

    // a redirect could send the ticket somewhere else: it fails instead
    const request = new Request(new URL(path, peer).toString(), {
      method: 'POST',
      redirect: 'manual',
      ...rest,
      headers: { ...buildTicketHeader(ticket), ...extraHeaders },
    });

    return fetchPeer(request);
  };

  // The commit, then the source's copy goes: whenever the target says the
  // imp is live there, whether on this call or one before a crash
  const runCommit = async (imp: ImpRecord, peer: string, ticket: string): Promise<void> => {
    await deps.releaseName().catch((error: unknown) => {
      deps.log(
        `impd: move: ${imp.name}: tailnet name not released yet: ${readErrorMessage(error)}`,
      );
    });

    const response = await sendToPeer(peer, MOVE_PATHS.commit, ticket);
    const answer = await requireOk(response, 'commit');

    const reply = MoveCommitReplySchema.parse(answer);

    if (!reply.isCommitted) {
      throw new Error('commit: the target did not commit');
    }

    // a resume and an abort at once can both reach here; one destroys it
    try {
      await deps.imps.destroyImp(imp.name, { isMove: true });
    } catch (error) {
      if (!(error instanceof ORPCError && error.code === 'NOT_FOUND')) {
        throw error;
      }
    }

    await deps.db.deleteFrom('move_sends').where('imp_id', '=', imp.id).execute();

    deps.log(`impd: move: ${imp.name}: committed on ${peer}; the copy here is gone`);
  };

  const runSend = async (imp: ImpRecord, target: SendTarget, progress: SendProgress) => {
    const peer = target.peer;
    const ticket = target.ticket;
    const secret = parseTicket(ticket)?.secret ?? '';
    const signal = progress.signal;

    const image = await findImageById(deps.db, imp.imageId);

    const meta = target.isWarm ? requireMeta(imp) : null;

    const offer = await sendToPeer(peer, MOVE_PATHS.offer, ticket, {
      body: JSON.stringify({
        imageDigest: image?.digest ?? '',
        ...(meta !== null && { systemDrive: meta.systemDrive }),
      }),
      signal,
      extraHeaders: { 'content-type': 'application/json' },
    });

    const offered = await requireOk(offer, 'offer');

    const reply = MoveOfferReplySchema.parse(offered);

    if (target.mode === 'zfs' && reply.storage !== 'zfs') {
      throw new Error('the target is not on ZFS any more; prepare the move again');
    }

    const warm = meta === null ? null : { meta, isDriveIncluded: reply.needsSystemDrive };

    const opened = await openParts(imp, target.mode, reply.needsImage, warm);

    const sent: SentFile[] = [];

    try {
      const header = await buildHeader(imp, reply.needsImage, opened.streams, warm);

      const frames = encodeStream(header, opened.parts, progress.onData, (file) => {
        sent.push(file);
      });

      await sendInParts(
        frames,
        async (part, body) => {
          const sentPart = await sendToPeer(peer, MOVE_PATHS.receive, ticket, {
            body,
            duplex: 'half',
            signal,
            extraHeaders: { [MOVE_PART_HEADER]: String(part) },
          });

          await requireOk(sentPart, `part ${String(part)}`);
        },
        deps.partBytes,
      );
    } finally {
      await removeParts(opened);
    }

    const response = await sendToPeer(peer, MOVE_PATHS.receive, ticket, {
      signal,
      extraHeaders: { [MOVE_FINISH_HEADER]: '1' },
    });

    const answer = await requireOk(response, 'receive');

    const receipt = ReceiptSchema.parse(answer);
    const body = readReceipt(receipt, secret);

    if (body === null) {
      throw new Error('the receipt is not signed with this ticket');
    }

    checkReceiptFiles(body, imp, sent);

    // from here both hosts hold the imp, and neither may wake it
    await deps.db
      .updateTable('move_sends')
      .set({ receipt: JSON.stringify(receipt) })
      .where('imp_id', '=', imp.id)
      .execute();

    await updateImpMove(deps.db, imp.id, 'moved');
    await runCommit(imp, peer, ticket);
  };

  // in the background, so a target that is down never holds up impd's start
  const runCommitAfterRestart = async (imp: ImpRecord, peer: string, ticket: string) => {
    try {
      await runCommit(imp, peer, ticket);
    } catch (error) {
      deps.log(`impd: move: ${imp.name}: commit after restart: ${readErrorMessage(error)}`);
    }
  };

  // The target's answer to an abort. Before the receipt it cannot have
  // committed, so a ticket it no longer knows means it holds nothing.
  const sendAbort = async (
    imp: ImpRecord,
    peer: string,
    ticket: string,
  ): Promise<'aborted' | 'committed'> => {
    const response = await sendToPeer(peer, MOVE_PATHS.abort, ticket);
    const answer = await readJsonBody(response);

    const reply = MoveCommitReplySchema.safeParse(answer);

    if (reply.success && reply.data.isCommitted) {
      return 'committed';
    }

    const isForgotten = response.status === 401 && imp.moveState === 'sending';

    if (response.ok || isForgotten) {
      return 'aborted';
    }

    throw new Error(`abort: the target answered ${String(response.status)}`);
  };

  const removeMark = async (imp: ImpRecord): Promise<void> => {
    await updateImpMove(deps.db, imp.id, null);

    await deps.db.deleteFrom('move_sends').where('imp_id', '=', imp.id).execute();
  };

  // Before a receipt, a failure undoes the move on both hosts. The mark and
  // the row stay until the target confirms, so no staged copy is left
  // behind with nothing here to end it; `imp move --abort` asks again.
  const resetSend = async (
    imp: ImpRecord,
    peer: string | null,
    ticket: string | null,
  ): Promise<boolean> => {
    if (peer === null || ticket === null) {
      await removeMark(imp);

      return true;
    }

    try {
      await sendAbort(imp, peer, ticket);
    } catch (error) {
      const message = `the target did not confirm the abort (${readErrorMessage(error)}); run imp move ${imp.name} <host> --abort`;

      await deps.db
        .updateTable('move_sends')
        .set({ error: message })
        .where('imp_id', '=', imp.id)
        .execute();

      deps.log(`impd: move: ${imp.name}: ${message}`);

      return false;
    }

    await removeMark(imp);

    return true;
  };

  const startSend = (imp: ImpRecord, target: SendTarget, totalBytes: number): SendTask => {
    const peer = target.peer;
    const ticket = target.ticket;

    const task: SendTask = {
      abort: new AbortController(),
      done: Promise.resolve(),
      sentBytes: 0,
      totalBytes,
      error: null,
      isDone: false,
    };

    const run = async (): Promise<void> => {
      try {
        await runSend(imp, target, {
          signal: task.abort.signal,
          onData: (bytes) => {
            task.sentBytes += bytes;
          },
        });

        task.isDone = true;
      } catch (error) {
        const message = readErrorMessage(error);

        deps.log(`impd: move: ${imp.name}: ${message}`);

        const fresh = await findImpById(deps.db, imp.id);

        if (fresh?.moveState === 'sending') {
          await resetSend(imp, peer, ticket);
        }

        // only now: a caller that sees the error sees the mark as the
        // reset left it
        task.error = message;
      } finally {
        finished.set(imp.id, { error: task.error, isDone: task.isDone });
        tasks.delete(imp.id);
      }
    };

    tasks.set(imp.id, task);

    task.done = run();

    return task;
  };

  const readStatusOf = async (imp: ImpRecord): Promise<MoveStatus> => {
    const task = tasks.get(imp.id);

    const row = await findSendRow(imp.id);

    const last = finished.get(imp.id);

    return {
      state: imp.moveState,
      peer: row?.peer_url ?? null,
      sentBytes: task?.sentBytes ?? 0,
      totalBytes: task?.totalBytes ?? row?.total_bytes ?? 0,
      isDone: task?.isDone ?? last?.isDone ?? false,
      error: task?.error ?? row?.error ?? last?.error ?? null,
    };
  };

  // A sleeping imp moves warm only to a target that can load its memory;
  // else the refusal names each fact that differs
  const checkWarmMove = async (
    imp: ImpRecord,
    meta: SnapshotMeta,
    target: WarmHost | null,
  ): Promise<WarmMove> => {
    const egress = await deps.egress.readPolicy(imp.name);

    const move = buildWarmMove(imp.slot, egress.mode, meta, deps.readWarmHost());

    const mismatches =
      target === null
        ? ['the target does not say what it can load']
        : findWarmMismatches(move, target);

    // The guest knows its gateway by this tap's MAC. A tap made before taps
    // took their slot's MAC has a random one, which no target tap has; with
    // no tap (a host restart removed it), the guest may still hold one
    const address = deriveSlotAddress(imp.slot, { subnet: deps.config.subnet, portBase: 0 });
    const tapMac = (deps.readTapMac ?? readTapMac)(address.tap);

    if (tapMac === null) {
      mismatches.push(`it has no tap ${address.tap} since a restart; wake it once first`);
    } else if (tapMac !== address.hostMac) {
      mismatches.push(`its tap ${address.tap} has a MAC from before slot MACs (${tapMac})`);
    }

    // the guest holds its peers' addresses, which are other imps' on the target
    const members = await listNetworkMembers(deps.db);

    const networks = members
      .filter((member) => member.impId === imp.id)
      .map((member) => member.network);

    if (networks.length > 0) {
      mismatches.push(`it is on private networks (${networks.join(', ')}); imp net leave first`);
    }

    if (mismatches.length > 0) {
      throw new ORPCError('PRECONDITION_FAILED', {
        message: `${imp.name} cannot move with its memory: ${mismatches.join('; ')}. imp move --stop moves it cold`,
      });
    }

    return move;
  };

  const requirePeer = (to: string): string => {
    const address = readPeerUrlAddress(to);

    if (address === null || !deps.ranges.isAllowed(address)) {
      throw new ORPCError('BAD_REQUEST', {
        message: `${to}: a move goes only to a literal tailnet address`,
      });
    }

    return to;
  };

  const runRecover = async (): Promise<void> => {
    try {
      for (const imp of await listImps(deps.db)) {
        const row = await findSendRow(imp.id);

        if (imp.moveState === 'sending') {
          const isUndone = await resetSend(imp, row?.peer_url ?? null, row?.ticket ?? null);

          if (isUndone) {
            deps.log(`impd: move: ${imp.name}: a send cut short by a restart was undone`);
          }
        }

        if (
          imp.moveState === 'moved' &&
          row !== undefined &&
          row.peer_url !== null &&
          row.ticket !== null
        ) {
          await runCommitAfterRestart(imp, row.peer_url, row.ticket);
        }
      }
    } catch (error) {
      deps.log(`impd: move: recovery after a restart failed: ${readErrorMessage(error)}`);
    }
  };

  return {
    prepare: (name, options) =>
      deps.imps.lockImp(name, async (imp) => {
        if (imp.publicAuth !== null) {
          throw buildPublicError(name);
        }

        const isWarm = imp.state === 'sleeping' && !options.stop;

        if (isWarm) {
          // the snapshot is read here, under the lock, and again at the send
        } else if (imp.state === 'running' || imp.state === 'sleeping') {
          if (!options.stop) {
            throw buildInvalidStateError(imp.state, ['stopped', 'sleeping'], 'move');
          }

          await deps.imps.haltImp(imp);
        } else if (imp.state !== 'stopped') {
          throw buildInvalidStateError(imp.state, ['stopped'], 'move');
        }

        const meta = isWarm ? requireMeta(imp) : null;
        const warm = meta === null ? null : await checkWarmMove(imp, meta, options.target);
        const isZfs = deps.storage.kind === 'zfs' && options.targetStorage === 'zfs';
        const mode: MoveMode = isZfs ? 'zfs' : 'files';

        const bytes = await countBytes(imp, mode, meta);

        await deps.db
          .insertInto('move_sends')
          .values({
            imp_id: imp.id,
            peer_url: null,
            ticket: null,
            total_bytes: bytes,
            mode,
            warm: isWarm ? 1 : 0,
            receipt: null,
            error: null,
            created_at: deps.now(),
          })
          .execute();

        const marked = await updateImpMove(deps.db, imp.id, 'sending');

        // an expose that landed before the mark; none lands after it
        if (marked.publicAuth !== null) {
          await removeMark(imp);

          throw buildPublicError(name);
        }

        finished.delete(imp.id);

        const checkpoints = await listCheckpoints(deps.db, imp.id);

        return { bytes, checkpoints: checkpoints.length, warm };
      }),

    send: async (name, to, ticket) => {
      const peer = requirePeer(to);

      const imp = await requireImp(name);
      const row = await findSendRow(imp.id);

      if (imp.moveState !== 'sending' || row === undefined || tasks.has(imp.id)) {
        throw new ORPCError('CONFLICT', {
          message: `${name} is not prepared for a send: run moves.prepare first`,
          data: { kind: 'imp' as const, name },
        });
      }

      await deps.db
        .updateTable('move_sends')
        .set({ peer_url: peer, ticket })
        .where('imp_id', '=', imp.id)
        .execute();

      startSend(imp, { peer, ticket, mode: row.mode, isWarm: row.warm === 1 }, row.total_bytes);

      return readStatusOf(imp);
    },

    readStatus: async (name) => {
      const imp = await findImpByName(deps.db, name);

      if (imp === undefined) {
        return { state: null, peer: null, sentBytes: 0, totalBytes: 0, isDone: true, error: null };
      }

      return readStatusOf(imp);
    },

    resume: async (name, ticket) => {
      const imp = await requireImp(name);
      const row = await findSendRow(imp.id);

      const useTicket = ticket ?? row?.ticket ?? null;

      if (row === undefined || row.peer_url === null || useTicket === null) {
        throw new ORPCError('CONFLICT', {
          message: `${name} has no move to resume`,
          data: { kind: 'imp' as const, name },
        });
      }

      if (ticket !== undefined) {
        await deps.db
          .updateTable('move_sends')
          .set({ ticket })
          .where('imp_id', '=', imp.id)
          .execute();
      }

      if (imp.moveState === 'moved') {
        await withPeerError(() => runCommit(imp, row.peer_url ?? '', useTicket));

        return {
          state: null,
          peer: row.peer_url,
          sentBytes: 0,
          totalBytes: 0,
          isDone: true,
          error: null,
        };
      }

      // a send a crash cut short starts over, with a new ticket
      if (imp.moveState === 'sending' && !tasks.has(imp.id) && ticket !== undefined) {
        startSend(
          imp,
          { peer: row.peer_url, ticket, mode: row.mode, isWarm: row.warm === 1 },
          row.total_bytes,
        );

        return readStatusOf(imp);
      }

      return readStatusOf(imp);
    },

    abort: async (name) => {
      const imp = await requireImp(name);

      const task = tasks.get(imp.id);

      if (task !== undefined) {
        task.abort.abort();

        await task.done;

        const fresh = await findImpById(deps.db, imp.id);

        return readStatusOf(fresh ?? imp);
      }

      const row = await findSendRow(imp.id);

      const peer = row?.peer_url ?? null;
      const ticket = row?.ticket ?? null;
      const isMarked = imp.moveState === 'sending' || imp.moveState === 'moved';

      if (isMarked && peer !== null && ticket !== null) {
        const outcome = await withPeerError(() => sendAbort(imp, peer, ticket));

        // the target committed: the copy here is the one to go
        if (outcome === 'committed') {
          await withPeerError(() => runCommit(imp, peer, ticket));

          return { state: null, peer, sentBytes: 0, totalBytes: 0, isDone: true, error: null };
        }
      }

      if (isMarked) {
        await removeMark(imp);
      }

      const after = await findImpById(deps.db, imp.id);

      return readStatusOf(after ?? imp);
    },

    // in the background, so impd listens at once; a target that is down
    // leaves its imp marked, with the error in its status
    recover: () => {
      void runRecover();

      return Promise.resolve();
    },
  };
}

// what the target or the network said, as the caller's error: never a bare 500
async function withPeerError<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ORPCError) {
      throw error;
    }

    throw new ORPCError('BAD_GATEWAY', { message: readErrorMessage(error), cause: error });
  }
}
