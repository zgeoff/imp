import { existsSync } from 'node:fs';
import type { MovePlan, MoveStatus } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { buildInvalidStateError, buildNotFoundError } from '../api-errors';
import type { Broker } from '../broker/broker-service';
import { listCheckpoints } from '../db/checkpoints';
import { findImageById } from '../db/images';
import { findImpById, findImpByName, listImps, updateImpMove } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { EgressService } from '../egress/egress-service';
import type { Imps } from '../imps/imp-service';
import { readErrorMessage } from '../read-error-message';
import { buildImagePaths } from '../storage/data-layout';
import type { StorageBackend } from '../storage/storage-backend';
import { MOVE_FRAMES, countDataBytes, encodeFile, encodeJsonFrame } from './move-frames';
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

export interface MoveSender {
  readonly prepare: (name: string, stop: boolean) => Promise<MovePlan>;
  readonly send: (name: string, to: string, ticket: string) => Promise<MoveStatus>;
  readonly readStatus: (name: string) => Promise<MoveStatus>;
  readonly resume: (name: string, ticket: string | undefined) => Promise<MoveStatus>;
  readonly abort: (name: string) => Promise<MoveStatus>;

  // at start: a send a crash cut short aborts; a verified copy commits
  readonly recover: () => Promise<void>;
}

export interface MoveSenderDeps {
  readonly db: ImpDatabase;
  readonly dataDir: string;
  readonly storage: Pick<StorageBackend, 'kind' | 'resolveImpPaths' | 'findCheckpointFile'>;
  readonly imps: Pick<Imps, 'lockImp' | 'haltImp' | 'destroyImp'>;
  readonly grants: Pick<Broker, 'listGrants'>;
  readonly egress: Pick<EgressService, 'readPolicy'>;
  readonly ranges: PeerRanges;

  // after the receipt: the tailnet-names pass, which drops this host's name
  readonly releaseName: () => Promise<void>;
  readonly fetch?: (request: Request) => Promise<Response>;
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

interface SourceFile {
  readonly path: string;
  readonly file: MoveFile;
}

type SentFile = ReceiptBody['files'][number];

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
  files: readonly SourceFile[],
  onData: (bytes: number) => void,
  onFile: (file: SentFile) => void,
): AsyncGenerator<Uint8Array, void, undefined> {
  yield encodeJsonFrame(MOVE_FRAMES.header, header);

  for (const source of files) {
    let bytes = 0;

    yield* encodeFile(
      source.path,
      source.file,
      (count) => {
        bytes += count;

        onData(count);
      },
      (sha256) => {
        onFile({
          kind: source.file.kind,
          ...(source.file.index !== undefined && { index: source.file.index }),
          sha256,
          bytes,
        });
      },
    );
  }

  yield encodeJsonFrame(MOVE_FRAMES.end, {});
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

  // the files a send carries, in order: the image (when asked), each
  // checkpoint oldest first, then the disk
  const listFiles = async (imp: ImpRecord, isImageIncluded: boolean): Promise<SourceFile[]> => {
    const image = await findImageById(deps.db, imp.imageId);

    if (image === undefined) {
      throw new Error(`${imp.name} has no image row`);
    }

    const listed = await listCheckpoints(deps.db, imp.id);

    const checkpoints = listed.toReversed();
    const imagePaths = buildImagePaths(deps.dataDir, image.digest);

    const files: SourceFile[] = isImageIncluded
      ? [
          { path: imagePaths.rootfs, file: { kind: 'image-rootfs', sizeBytes: 0 } },
          { path: imagePaths.config, file: { kind: 'image-config', sizeBytes: 0 } },
        ]
      : [];

    for (const [index, checkpoint] of checkpoints.entries()) {
      const path = deps.storage.findCheckpointFile(imp.id, checkpoint.id);

      if (path === null || !existsSync(path)) {
        throw new Error(`checkpoint ${checkpoint.id} has no file to send`);
      }

      files.push({ path, file: { kind: 'checkpoint', index, sizeBytes: 0 } });
    }

    files.push({
      path: deps.storage.resolveImpPaths(imp.id).disk,
      file: { kind: 'disk', sizeBytes: 0 },
    });

    return files;
  };

  const buildHeader = async (imp: ImpRecord, isImageIncluded: boolean): Promise<MoveHeader> => {
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
      },
      image: {
        name: image.name,
        ref: image.ref,
        digest: image.digest,
        sizeBytes: image.sizeBytes,
        isIncluded: isImageIncluded,
      },
      checkpoints: checkpoints.map((checkpoint) => ({
        label: checkpoint.label,
        createdAt: checkpoint.createdAt,
        diskBytes: checkpoint.diskBytes,
      })),
    };
  };

  const sendToPeer = (
    peer: string,
    path: string,
    ticket: string,
    init: PeerRequest = {},
  ): Promise<Response> => {
    const { extraHeaders, ...rest } = init;

    const request = new Request(new URL(path, peer).toString(), {
      method: 'POST',
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

    await deps.imps.destroyImp(imp.name, { isMove: true });
    await deps.db.deleteFrom('move_sends').where('imp_id', '=', imp.id).execute();

    deps.log(`impd: move: ${imp.name}: committed on ${peer}; the copy here is gone`);
  };

  const runSend = async (imp: ImpRecord, peer: string, ticket: string, progress: SendProgress) => {
    const secret = parseTicket(ticket)?.secret ?? '';
    const signal = progress.signal;

    const image = await findImageById(deps.db, imp.imageId);

    const offer = await sendToPeer(peer, MOVE_PATHS.offer, ticket, {
      body: JSON.stringify({ imageDigest: image?.digest ?? '' }),
      signal,
      extraHeaders: { 'content-type': 'application/json' },
    });

    const offered = await requireOk(offer, 'offer');

    const needsImage = MoveOfferReplySchema.parse(offered).needsImage;

    const header = await buildHeader(imp, needsImage);
    const files = await listFiles(imp, needsImage);

    const sent: SentFile[] = [];

    const frames = encodeStream(header, files, progress.onData, (file) => {
      sent.push(file);
    });

    await sendInParts(frames, async (part, body) => {
      const sentPart = await sendToPeer(peer, MOVE_PATHS.receive, ticket, {
        body,
        duplex: 'half',
        signal,
        extraHeaders: { [MOVE_PART_HEADER]: String(part) },
      });

      await requireOk(sentPart, `part ${String(part)}`);
    });

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

  // before a receipt, a failure undoes the move on both hosts
  const resetSend = async (imp: ImpRecord, peer: string | null, ticket: string | null) => {
    if (peer !== null && ticket !== null) {
      await sendToPeer(peer, MOVE_PATHS.abort, ticket).catch((error: unknown) => {
        deps.log(`impd: move: ${imp.name}: the target's abort failed: ${readErrorMessage(error)}`);
      });
    }

    await updateImpMove(deps.db, imp.id, null);

    await deps.db.deleteFrom('move_sends').where('imp_id', '=', imp.id).execute();
  };

  const startSend = (
    imp: ImpRecord,
    peer: string,
    ticket: string,
    totalBytes: number,
  ): SendTask => {
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
        await runSend(imp, peer, ticket, {
          signal: task.abort.signal,
          onData: (bytes) => {
            task.sentBytes += bytes;
          },
        });

        task.isDone = true;
      } catch (error) {
        task.error = readErrorMessage(error);

        deps.log(`impd: move: ${imp.name}: ${task.error}`);

        const fresh = await findImpById(deps.db, imp.id);

        if (fresh?.moveState === 'sending') {
          await resetSend(imp, peer, ticket);
        }
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

  const requirePeer = (to: string): string => {
    const address = readPeerUrlAddress(to);

    if (address === null || !deps.ranges.isAllowed(address)) {
      throw new ORPCError('BAD_REQUEST', {
        message: `${to}: a move goes only to a literal tailnet address`,
      });
    }

    return to;
  };

  return {
    prepare: (name, stop) =>
      deps.imps.lockImp(name, async (imp) => {
        if (deps.storage.kind !== 'xfs') {
          throw new ORPCError('PRECONDITION_FAILED', {
            message: 'moves from a ZFS host are not built yet',
          });
        }

        if (imp.state === 'running' || imp.state === 'sleeping') {
          if (!stop) {
            throw buildInvalidStateError(imp.state, ['stopped'], 'move');
          }

          await deps.imps.haltImp(imp);
        } else if (imp.state !== 'stopped') {
          throw buildInvalidStateError(imp.state, ['stopped'], 'move');
        }

        let bytes = 0;

        for (const source of await listFiles(imp, true)) {
          bytes += await countDataBytes(source.path);
        }

        await deps.db
          .insertInto('move_sends')
          .values({
            imp_id: imp.id,
            peer_url: null,
            ticket: null,
            total_bytes: bytes,
            receipt: null,
            error: null,
            created_at: deps.now(),
          })
          .execute();

        await updateImpMove(deps.db, imp.id, 'sending');

        finished.delete(imp.id);

        const checkpoints = await listCheckpoints(deps.db, imp.id);

        return { bytes, checkpoints: checkpoints.length };
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

      startSend(imp, peer, ticket, row.total_bytes);

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
        await runCommit(imp, row.peer_url, useTicket);

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
        startSend(imp, row.peer_url, ticket, row.total_bytes);

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

      if (
        imp.moveState === 'moved' &&
        row !== undefined &&
        row.peer_url !== null &&
        row.ticket !== null
      ) {
        const response = await sendToPeer(row.peer_url, MOVE_PATHS.abort, row.ticket);
        const answer = await readJsonBody(response);

        const reply = MoveCommitReplySchema.safeParse(answer);

        // the target committed: the copy here is the one to go
        if (reply.success && reply.data.isCommitted) {
          await runCommit(imp, row.peer_url, row.ticket);

          return {
            state: null,
            peer: row.peer_url,
            sentBytes: 0,
            totalBytes: 0,
            isDone: true,
            error: null,
          };
        }

        if (!response.ok) {
          throw new Error(`abort: the target answered ${String(response.status)}`);
        }
      }

      if (imp.moveState === 'sending' || imp.moveState === 'moved') {
        await updateImpMove(deps.db, imp.id, null);

        await deps.db.deleteFrom('move_sends').where('imp_id', '=', imp.id).execute();
      }

      const after = await findImpById(deps.db, imp.id);

      return readStatusOf(after ?? imp);
    },

    recover: async () => {
      for (const imp of await listImps(deps.db)) {
        const row = await findSendRow(imp.id);

        if (imp.moveState === 'sending') {
          await resetSend(imp, row?.peer_url ?? null, row?.ticket ?? null);

          deps.log(`impd: move: ${imp.name}: a send cut short by a restart was undone`);
        }

        if (
          imp.moveState === 'moved' &&
          row !== undefined &&
          row.peer_url !== null &&
          row.ticket !== null
        ) {
          void runCommitAfterRestart(imp, row.peer_url, row.ticket);
        }
      }
    },
  };
}
