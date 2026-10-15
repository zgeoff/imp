import type { MovePlan, MoveStatus, WarmHost } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { buildInvalidStateError, buildNotFoundError } from '../api-errors';
import type { Broker } from '../broker/broker-service';
import type { Config } from '../config';
import { listCheckpoints } from '../db/checkpoints';
import { listColdBoots } from '../db/cold-boots';
import { findImageById } from '../db/images';
import { findImpById, findImpByName, listImps, updateImpMove } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { findMoveSend, removeMoveSend, updateMoveSend, writeMoveSend } from '../db/move-sends';
import type { ImpDatabase } from '../db/open-database';
import type { EgressService } from '../egress/egress-service';
import type { LockedImp } from '../imps/imp-lock';
import type { Imps } from '../imps/imp-service';
import type { StreamedCommand } from '../process/run-stream';
import { readErrorMessage } from '../read-error-message';
import { encodeSnapshotMeta } from '../sleep/snapshot-meta';
import type { SnapshotMeta } from '../sleep/snapshot-meta';
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
import { buildMovedLeases, requireLeasesKept } from './move-leases';
import { sendInParts } from './move-parts';
import { ReceiptSchema, buildTicketHeader, parseTicket, readReceipt } from './move-tickets';
import type { ReadonlyReceiptBody, ReceiptBody } from './move-tickets';
import { OfferRefusalError } from './offer-refusal-error';
import { readPeerUrlAddress } from './peer-address';
import type { PeerRanges } from './peer-address';
import { buildWarmHeader, checkWarmMove, requireSnapshotMeta } from './warm-move';
import type { WarmParts } from './warm-move';

export interface MoveSender {
  readonly prepare: (name: string, options: PrepareOptions) => Promise<MovePlan>;
  readonly send: (name: string, to: string, ticket: string) => Promise<MoveStatus>;
  readonly readStatus: (name: string) => Promise<MoveStatus>;
  readonly resume: (name: string, ticket: string | undefined) => Promise<MoveStatus>;
  readonly abort: (name: string) => Promise<MoveStatus>;

  // at start: a send a crash cut short aborts; a verified copy commits
  readonly recover: () => Promise<void>;

  // settles once the recovery that `recover` last started has run, at once
  // when none has; it never rejects, as the recovery logs its own failure
  readonly waitForRecovery: () => Promise<void>;
}

interface PrepareOptions {
  readonly stop: boolean;

  // a stop of a leased imp ends its leases from leases.* rather than fail
  // with LEASED, as `imps.stop` does
  readonly force: boolean;
  readonly targetStorage: 'xfs' | 'zfs';

  // the target's facts, for a warm move; null from an older CLI or target
  readonly target: WarmHost | null;
}

export interface MoveSenderDeps {
  readonly config: Pick<Config, 'subnet'>;
  readonly db: ImpDatabase;
  readonly dataDir: string;
  readonly storage: Pick<StorageBackend, 'kind' | 'openMoveSource' | 'resolveImpPaths'>;
  readonly imps: Pick<
    Imps,
    | 'lockImp'
    | 'haltImp'
    | 'destroyImp'
    | 'startImp'
    | 'requireRunningImp'
    | 'requireUnleased'
    | 'endForcedLeases'
  >;
  readonly grants: Pick<Broker, 'listGrantDetails'>;
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
  yield encodeJsonFrame(MOVE_FRAMES.header, encodeHeader(header));

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

// The header as JSON: a warm move's snapshot record goes as meta.json holds
// it, its sessions and services in the agent's own JSON form
function encodeHeader(header: Readonly<MoveHeader>): unknown {
  if (header.warm === null) {
    return header;
  }

  return { ...header, warm: { ...header.warm, meta: encodeSnapshotMeta(header.warm.meta) } };
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

  // imps the prepare stopped while they ran; a refusal before any byte went
  // starts them again
  const halted = new Set<string>();

  const requireImp = async (name: string): Promise<ImpRecord> => {
    const imp = await findImpByName(deps.db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return imp;
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
    const grants = await deps.grants.listGrantDetails(imp.name);
    const leases = await buildMovedLeases(deps, imp);

    return {
      version: 1,
      imp: {
        id: imp.id,
        name: imp.name,
        vcpus: imp.vcpus,
        memoryMib: imp.memoryMib,
        maxMemoryMib: imp.maxMemoryMib,
        httpPort: imp.httpPort,
        diskBytes: imp.diskBytes,
        cpu: imp.cpu,
        egress: { mode: egress.mode, allow: [...egress.allow] },
        grants: grants.filter((grant) => grant.filter === null).map((grant) => grant.secret),
        filteredGrants: grants.flatMap((grant) =>
          grant.filter === null ? [] : [{ secret: grant.secret, filter: grant.filter }],
        ),
        isIdentityResetPending: imp.isIdentityResetPending,
        isDiskGrowPending: imp.isDiskGrowPending,
        isBackedUp: imp.isBackedUp,
        coldBoots: await listColdBoots(deps.db, imp.id),
        leases,
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
      warm: warm === null ? null : await buildWarmHeader(deps, imp, warm),
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

    await removeMoveSend(deps.db, imp.id);

    deps.log(`impd: move: ${imp.name}: committed on ${peer}; the copy here is gone`);
  };

  const runSend = async (imp: ImpRecord, target: SendTarget, progress: SendProgress) => {
    const peer = target.peer;
    const ticket = target.ticket;
    const secret = parseTicket(ticket)?.secret ?? '';
    const signal = progress.signal;

    const image = await findImageById(deps.db, imp.imageId);

    const meta = target.isWarm ? requireSnapshotMeta(deps, imp) : null;

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

    // a target from before elastic memory would land the imp at a fixed size
    if (imp.maxMemoryMib > imp.memoryMib && !reply.keepsMaxMemory) {
      throw new OfferRefusalError(
        "the target's impd predates elastic memory and would drop the imp's max memory; upgrade it first",
      );
    }

    await requireLeasesKept(deps, imp, reply.keepsLeases);

    // a target from before the setting would put the imp's disk in its backups
    if (!imp.isBackedUp && !reply.keepsBackupOff) {
      throw new OfferRefusalError(
        "the target's impd predates imps left out of backups and would back this one up; upgrade it first",
      );
    }

    // a move never changes the policy, either way
    const policy = await deps.egress.readPolicy(imp.name);

    if (policy.mode === 'public' && !reply.keepsPublicEgress) {
      throw new OfferRefusalError(
        "the target's impd predates the public egress policy and would receive the imp as none; upgrade it first",
      );
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
    await updateMoveSend(deps.db, imp.id, { receipt: JSON.stringify(receipt) });
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
    await removeMoveSend(deps.db, imp.id);
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

      await updateMoveSend(deps.db, imp.id, { error: message });

      deps.log(`impd: move: ${imp.name}: ${message}`);

      return false;
    }

    await removeMark(imp);

    return true;
  };

  const startHaltedAgain = async (imp: ImpRecord): Promise<void> => {
    try {
      await deps.imps.startImp(imp.name);
    } catch (error) {
      deps.log(`impd: move: ${imp.name}: could not start it again: ${readErrorMessage(error)}`);
    }
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

        // the offer came after the prepare's halt: nothing went, so the imp
        // runs again as it did before the move
        if (error instanceof OfferRefusalError && halted.has(imp.id)) {
          await startHaltedAgain(imp);
        }

        // only now: a caller that sees the error sees the mark as the
        // reset left it
        task.error = message;
      } finally {
        halted.delete(imp.id);
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

    const row = await findMoveSend(deps.db, imp.id);

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

  // What prepare writes once the imp is stopped or asleep: the send's row
  // and the mark, after which no call but the move's own reaches the imp
  const writeSendMark = async (
    imp: LockedImp,
    options: PrepareOptions,
    isWarm: boolean,
  ): Promise<MovePlan> => {
    const meta = isWarm ? requireSnapshotMeta(deps, imp) : null;
    const warm = meta === null ? null : await checkWarmMove(deps, imp, meta, options.target);
    const isZfs = deps.storage.kind === 'zfs' && options.targetStorage === 'zfs';
    const mode: MoveMode = isZfs ? 'zfs' : 'files';

    const bytes = await countBytes(imp, mode, meta);

    await writeMoveSend(deps.db, {
      imp_id: imp.id,
      peer_url: null,
      ticket: null,
      total_bytes: bytes,
      mode,
      warm: isWarm ? 1 : 0,
      receipt: null,
      error: null,
      created_at: deps.now(),
    });

    const marked = await updateImpMove(deps.db, imp.id, 'sending');

    // an expose that landed before the mark; none lands after it
    if (marked.publicAuth !== null) {
      await removeMark(imp);

      throw buildPublicError(imp.name);
    }

    finished.delete(imp.id);

    const checkpoints = await listCheckpoints(deps.db, imp.id);

    return { bytes, checkpoints: checkpoints.length, warm };
  };

  // A cold move's mark on the imp its prepare halted. A forced stop ends
  // the leases only once the mark is on; a failure before that keeps them,
  // and a running imp runs again.
  const writeHaltedMark = async (
    imp: LockedImp,
    stopped: LockedImp,
    options: PrepareOptions,
  ): Promise<MovePlan> => {
    try {
      const plan = await writeSendMark(stopped, options, false);

      if (options.force) {
        await deps.imps.endForcedLeases(stopped);
      }

      return plan;
    } catch (error) {
      // the mark is this prepare's own: the lock refused a marked imp
      await removeMark(imp);

      // only a running imp runs again; a sleeping one's memory is gone

      if (halted.delete(imp.id)) {
        await deps.imps.requireRunningImp(stopped).catch((startError: unknown) => {
          deps.log(
            `impd: move: ${imp.name}: could not start it again: ${readErrorMessage(startError)}`,
          );
        });
      }

      throw error;
    }
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

  // the background recovery recover last started
  const recovery: { last: Promise<void> } = { last: Promise.resolve() };

  const runRecover = async (): Promise<void> => {
    try {
      for (const imp of await listImps(deps.db)) {
        const row = await findMoveSend(deps.db, imp.id);

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

        // the snapshot is read here, under the lock, and again at the send
        if (isWarm || imp.state === 'stopped') {
          return writeSendMark(imp, options, isWarm);
        }

        if (imp.state !== 'running' && imp.state !== 'sleeping') {
          throw buildInvalidStateError(imp.state, ['stopped'], 'move');
        }

        if (!options.stop) {
          throw buildInvalidStateError(imp.state, ['stopped', 'sleeping'], 'move');
        }

        // LEASED first, as imps.stop checks, then the halt
        await deps.imps.requireUnleased(imp, options.force);

        const stopped = await deps.imps.haltImp(imp);

        if (imp.state === 'running') {
          halted.add(imp.id);
        }

        return writeHaltedMark(imp, stopped, options);
      }),

    send: async (name, to, ticket) => {
      const peer = requirePeer(to);

      const imp = await requireImp(name);
      const row = await findMoveSend(deps.db, imp.id);

      if (imp.moveState !== 'sending' || row === undefined || tasks.has(imp.id)) {
        throw new ORPCError('CONFLICT', {
          message: `${name} is not prepared for a send: run moves.prepare first`,
          data: { kind: 'imp' as const, name },
        });
      }

      await updateMoveSend(deps.db, imp.id, { peer_url: peer, ticket });

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
      const row = await findMoveSend(deps.db, imp.id);

      const useTicket = ticket ?? row?.ticket ?? null;

      if (row === undefined || row.peer_url === null || useTicket === null) {
        throw new ORPCError('CONFLICT', {
          message: `${name} has no move to resume`,
          data: { kind: 'imp' as const, name },
        });
      }

      if (ticket !== undefined) {
        await updateMoveSend(deps.db, imp.id, { ticket });
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

      const row = await findMoveSend(deps.db, imp.id);

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
      recovery.last = runRecover();

      return Promise.resolve();
    },
    waitForRecovery: () => recovery.last,
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
