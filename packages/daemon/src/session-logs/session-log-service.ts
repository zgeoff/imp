import type { PreviousGeneration, ResumeFrom, SessionLog, SessionLogRead } from '@imp/api';
import { PreviousGenerationSchema } from '@imp/api';
import * as z from 'zod';
import { AgentError } from '../agent-client/agent-connection';
import { isAgentLogIdentity } from '../agent-client/agent-ids';
import type { AgentSession } from '../agent-client/agent-requests';
import { openTapStream } from '../agent-client/exec-stream';
import type { ExecStream } from '../agent-client/exec-stream';
import { isDiskFullError } from '../api-errors';
import { readErrorMessage } from '../read-error-message';
import {
  countLogBytes,
  createGenerationLog,
  loadGenerationLog,
  readGenerationBounds,
  readGenerationMeta,
} from './generation-log';
import type { GenerationEnd, GenerationLog, GenerationLogOptions } from './generation-log';
import {
  findGenerationDir,
  hasTombstone,
  listTombstones,
  readImpMetas,
  readSessionLogRange,
  removeEmptyDirs,
  removeGenerationDir,
  removeTombstone,
  toApiSessionLog,
  writeTombstone,
} from './session-log-files';
import type { SessionLogReadRequest } from './session-log-files';

// Session logs (docs/architecture/daemon.md#session-logs). impd taps each
// session the agent marks `log`, beside its viewer, and writes its output
// under the imp's directory. Each look at the sessions taps what is untapped.

export interface SessionLogLimits {
  // one generation's log, of which it keeps at least half the newest
  readonly generationMaxBytes: number;

  // an imp's logs together; ended generations go first, oldest first, then
  // the live logs' oldest segments, then the newest live log stops
  readonly impMaxBytes: number;

  // live logs per imp: a forged agent can list any number of generations
  readonly impMaxLive: number;

  // an ended generation's log goes this long after it ended
  readonly maxAgeMs: number;
}

export interface SessionLogImp {
  readonly id: string;
  readonly state: string;
  readonly vsockPath: string;
  readonly sessionLogsDir: string;
}

type TappedSession = Pick<AgentSession, 'name' | 'execution_generation' | 'boot_id'>;

// what a delete names: without a generation every one of the session, and
// without a session every log of the imp
export interface SessionLogTarget {
  readonly session?: string | undefined;
  readonly executionGeneration?: string | undefined;
}

export interface SessionLogs {
  // a running imp's sessions as impd just listed them: taps each logged one
  // that is untapped, and ends the logs of generations that are gone
  readonly observe: (imp: SessionLogImp, sessions: readonly AgentSession[]) => void;

  // a session just started with log: tapped now, not at the next look
  readonly tapNow: (imp: SessionLogImp, session: Readonly<TappedSession>) => void;

  // the imp's VM is gone (a stop, an error): each of its live logs ends
  readonly endImp: (imp: SessionLogImp) => Promise<void>;

  // the imp is being destroyed: taps close and nothing more is written
  readonly forgetImp: (impId: string) => void;

  // an imp was made under the id, a move home included: it logs again
  readonly admitImp: (impId: string) => void;

  readonly listLogs: (imp: SessionLogImp, session?: string) => SessionLog[];
  readonly readLog: (imp: SessionLogImp, request: SessionLogReadRequest) => Promise<SessionLogRead>;
  readonly deleteLogs: (imp: SessionLogImp, target: SessionLogTarget) => number;

  // ends the live logs of imps whose VM is gone and removes ended logs past
  // their age; `imps` is every imp the database has
  readonly sweep: (imps: readonly SessionLogImp[]) => Promise<void>;
}

interface SessionLogDeps {
  readonly limits: SessionLogLimits;
  readonly requireRoom: (bytes: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string) => void;

  // how long appended bytes wait for their flush; a test shortens it
  readonly commitDelayMs?: number;
  readonly openTap?: (
    vsockPath: string,
    session: string,
    resumeFrom?: ResumeFrom,
  ) => Promise<ExecStream>;
}

// one generation impd logs now
interface LiveLog {
  readonly key: string;
  readonly impId: string;
  readonly session: string;
  readonly generation: string;
  readonly log: GenerationLog;
}

const SEGMENTS_PER_LOG = 2;

// an imp's limit is checked at least this often within a segment, so its logs
// pass it by at most this share of one
const LIMIT_CHECKS_PER_SEGMENT = 16;

// how often an imp at its cap of live logs says so
const CAP_NOTICE_MS = 60_000;

// NO_SESSION's data in the API's shape: the generation that last left the
// name, with its final end and exit code
const NoSessionPreviousSchema = z.object({ previous: PreviousGenerationSchema.optional() });

function findKey(impId: string, generation: string): string {
  return `${impId}/${generation}`;
}

// the final end of the generation `previous` names, if it is this one
function toPreviousEnd(
  previous: PreviousGeneration | undefined,
  generation: string,
): GenerationEnd {
  if (previous?.executionGeneration !== generation) {
    return {};
  }

  return { end: previous.end, exitCode: previous.exitCode };
}

function toExitCode(code: number, signal: number): number | null {
  return signal === 0 ? code : null;
}

export function createSessionLogs(deps: SessionLogDeps): SessionLogs {
  const openTap = deps.openTap ?? openTapStream;
  const segmentBytes = Math.max(1, Math.floor(deps.limits.generationMaxBytes / SEGMENTS_PER_LOG));
  const limitCheckBytes = Math.max(1, Math.floor(segmentBytes / LIMIT_CHECKS_PER_SEGMENT));

  // the bytes each imp's logs took since its limit was last checked
  const uncheckedBytes = new Map<string, number>();
  const live = new Map<string, LiveLog>();

  // each live log's tap, or `opening` while one is on its way
  const taps = new Map<string, Readonly<ExecStream> | 'opening'>();

  // never tapped again in this impd's life: deleted while live, or stopped
  const dropped = new Set<string>();

  // imps whose directory this impd has read since it started
  const recovered = new Set<string>();

  // generations whose log is being made, so the cap counts them
  const creating = new Set<string>();

  // destroyed imps not back yet: nothing is tapped or written for them
  const forgotten = new Set<string>();

  // how often each imp was destroyed: work that began before a destroy
  // writes nothing, even once the imp is back under its id (a move home)
  const lives = new Map<string, number>();

  const readLife = (impId: string) => lives.get(impId) ?? 0;

  const isForgotten = (impId: string, life: number) =>
    forgotten.has(impId) || readLife(impId) !== life;

  // when each imp last logged a refusal for its cap
  const capNotices = new Map<string, number>();

  const buildOptions = (imp: SessionLogImp, generation: string): GenerationLogOptions => ({
    dir: findGenerationDir(imp.sessionLogsDir, generation),
    segmentBytes,
    maxBytes: deps.limits.generationMaxBytes,
    requireRoom: deps.requireRoom,
    now: deps.now,
    log: deps.log,
    ...(deps.commitDelayMs !== undefined && { commitDelayMs: deps.commitDelayMs }),
  });

  const readLive = (impId: string) => (generation: string) =>
    live.get(findKey(impId, generation))?.log.readMeta() ?? null;

  const listLive = (impId: string) => [...live.values()].filter((entry) => entry.impId === impId);
  const isTapped = (key: string) => taps.has(key);

  const stopTap = (key: string): void => {
    const tap = taps.get(key);

    taps.delete(key);

    if (tap !== undefined && tap !== 'opening') {
      tap.close();
    }
  };

  const printError = (imp: SessionLogImp, error: unknown): void => {
    deps.log(`impd: session logs of imp ${imp.id}: ${readErrorMessage(error)}`);
  };

  const setLive = (imp: SessionLogImp, generation: string, session: string, log: GenerationLog) => {
    const entry: LiveLog = {
      key: findKey(imp.id, generation),
      impId: imp.id,
      session,
      generation,
      log,
    };

    live.set(entry.key, entry);

    return entry;
  };

  const writeEnd = async (entry: LiveLog, end: GenerationEnd): Promise<void> => {
    live.delete(entry.key);

    stopTap(entry.key);

    await entry.log.finish(end);
  };

  // the live logs an earlier impd left come back, so the rules that end or
  // tap live logs cover them too
  const loadImpLogs = async (imp: SessionLogImp, life: number): Promise<void> => {
    if (recovered.has(imp.id) || isForgotten(imp.id, life)) {
      return;
    }

    recovered.add(imp.id);

    for (const meta of readImpMetas(imp.sessionLogsDir, readLive(imp.id))) {
      const key = findKey(imp.id, meta.executionGeneration);

      if (meta.state === 'live' && !live.has(key)) {
        const options = buildOptions(imp, meta.executionGeneration);

        const log = await loadGenerationLog(options, meta);

        if (isForgotten(imp.id, life)) {
          log.abandon();

          return;
        }

        setLive(imp, meta.executionGeneration, meta.session, log);

        if (meta.stopped !== undefined) {
          dropped.add(key);
        }
      }
    }
  };

  const stopForLimit = async (imp: SessionLogImp, entry: LiveLog): Promise<void> => {
    deps.log(
      `impd: imp ${imp.id}: stopped the log of session ${entry.session}: its logs reached IMP_SESSION_LOG_IMP_MAX_MIB`,
    );

    dropped.add(entry.key);

    stopTap(entry.key);

    await entry.log.stop('imp_limit');
  };

  // ended logs go oldest first; then the largest live log gives up its
  // oldest segment; when every live log is down to one, the newest still
  // written stops, and stays as it is until its generation ends
  const applyImpLimit = async (imp: SessionLogImp): Promise<void> => {
    const countImpBytes = () =>
      readImpMetas(imp.sessionLogsDir, readLive(imp.id)).reduce(
        (sum, meta) => sum + countLogBytes(meta),
        0,
      );

    const metas = readImpMetas(imp.sessionLogsDir, readLive(imp.id));

    const ended = metas
      .filter((meta) => meta.state === 'ended')
      .toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));

    let total = countImpBytes();

    for (const meta of ended) {
      if (total <= deps.limits.impMaxBytes) {
        return;
      }

      removeGenerationDir(imp.sessionLogsDir, meta.executionGeneration);

      total -= countLogBytes(meta);
    }

    while (total > deps.limits.impMaxBytes) {
      const [largest] = listLive(imp.id).toSorted(
        (a, b) => countLogBytes(b.log.readMeta()) - countLogBytes(a.log.readMeta()),
      );

      if (largest === undefined) {
        return;
      }

      const isRemoved = await largest.log.removeOldestSegment();

      if (!isRemoved) {
        // the newest by start, and of two that started at once the later one
        const newest = listLive(imp.id)
          .filter((entry) => !dropped.has(entry.key))
          .reduce<LiveLog | undefined>(
            (found, entry) =>
              found === undefined ||
              entry.log.readMeta().startedAt >= found.log.readMeta().startedAt
                ? entry
                : found,
            undefined,
          );

        if (newest !== undefined) {
          await stopForLimit(imp, newest);
        }

        return;
      }

      total = countImpBytes();
    }
  };

  const countCreating = (impId: string) =>
    [...creating].filter((key) => key.startsWith(`${impId}/`)).length;

  // a log for a generation impd has not logged: null when the imp has its
  // cap of live logs, the generation was deleted, or the imp is destroyed
  const createLiveLog = async (
    imp: SessionLogImp,
    generation: string,
    session: string,
    bootId: string,
    life: number,
  ): Promise<LiveLog | null> => {
    const key = findKey(imp.id, generation);

    if (!isAgentLogIdentity({ generation, session, bootId })) {
      return null;
    }

    if (isForgotten(imp.id, life) || hasTombstone(imp.sessionLogsDir, generation)) {
      return null;
    }

    if (listLive(imp.id).length + countCreating(imp.id) >= deps.limits.impMaxLive) {
      const last = capNotices.get(imp.id) ?? 0;

      if (deps.now() - last >= CAP_NOTICE_MS) {
        capNotices.set(imp.id, deps.now());

        deps.log(
          `impd: imp ${imp.id}: logs no more sessions: it has ${String(deps.limits.impMaxLive)} live logs`,
        );
      }

      return null;
    }

    creating.add(key);

    let log: GenerationLog;

    try {
      log = await createGenerationLog(buildOptions(imp, generation), {
        session,
        executionGeneration: generation,
        bootId,
      });
    } finally {
      creating.delete(key);
    }

    // destroyed while the directory was made: it goes again, unless the imp
    // is back under its id, whose log of the generation it may be now
    if (isForgotten(imp.id, life)) {
      log.abandon();

      if (forgotten.has(imp.id)) {
        removeGenerationDir(imp.sessionLogsDir, generation);
        removeEmptyDirs(imp.sessionLogsDir);
      }

      return null;
    }

    return setLive(imp, generation, session, log);
  };

  const stopForFullDisk = async (imp: SessionLogImp, entry: LiveLog): Promise<void> => {
    deps.log(
      `impd: imp ${imp.id}: stopped the log of session ${entry.session}: the disk reached its reserve`,
    );

    dropped.add(entry.key);

    stopTap(entry.key);

    await entry.log.stop('disk_full');
  };

  // copies the tap into the log until it ends: an exit ends the log; a
  // detach or a dropped connection leaves it for the next look to tap again
  const runTap = async (imp: SessionLogImp, entry: LiveLog, tap: Readonly<ExecStream>) => {
    // each new segment is a new start: a log at its own bound adds one as it
    // drops one, so its count stays the same; growth within a segment counts
    // toward the next check too
    let newest = entry.log.readMeta().segments.at(-1)?.start;

    try {
      for await (const event of tap.events()) {
        if (event.type === 'stdout') {
          await entry.log.append(event.data);

          const start = entry.log.readMeta().segments.at(-1)?.start;
          const unchecked = (uncheckedBytes.get(imp.id) ?? 0) + event.data.byteLength;

          if (start !== newest || unchecked >= limitCheckBytes) {
            newest = start;

            uncheckedBytes.set(imp.id, 0);

            await applyImpLimit(imp);
          } else {
            uncheckedBytes.set(imp.id, unchecked);
          }
        } else if (event.type === 'exit') {
          const end = readGenerationBounds(entry.log.readMeta()).logEnd;

          await writeEnd(entry, { end, exitCode: toExitCode(event.code, event.signal) });
        }
      }
    } catch (error) {
      if (isDiskFullError(error)) {
        await stopForFullDisk(imp, entry);
      } else {
        printError(imp, error);
      }
    } finally {
      if (taps.get(entry.key) === tap) {
        stopTap(entry.key);
      }
    }
  };

  // generation_changed: the named generation is gone, and the tap carries
  // the one that runs now under the name, from its first offset
  const startNextGeneration = async (
    imp: SessionLogImp,
    entry: LiveLog,
    tap: Readonly<ExecStream>,
    life: number,
  ): Promise<void> => {
    const output = tap.output;

    if (output?.continuity !== 'offsets') {
      tap.close();

      return;
    }

    const identity = {
      generation: output.executionGeneration,
      session: entry.session,
      bootId: output.bootId,
    };

    // a forged next generation ends nothing and makes nothing
    if (!isAgentLogIdentity(identity)) {
      tap.close();

      return;
    }

    await writeEnd(entry, toPreviousEnd(output.previous, entry.generation));

    if (isForgotten(imp.id, life)) {
      tap.close();

      return;
    }

    const key = findKey(imp.id, output.executionGeneration);
    const dir = findGenerationDir(imp.sessionLogsDir, output.executionGeneration);

    if (isTapped(key) || dropped.has(key) || readGenerationMeta(dir) !== null) {
      tap.close();

      return;
    }

    taps.set(key, tap);

    const next = await createLiveLog(
      imp,
      output.executionGeneration,
      entry.session,
      output.bootId,
      life,
    );

    if (next === null || taps.get(key) !== tap) {
      taps.delete(key);
      tap.close();

      return;
    }

    next.log.setOrigin(output.offset);

    await runTap(imp, next, tap);
  };

  // NO_SESSION or BAD_REQUEST (no longer logged): the generation ended
  const writeGoneEnd = async (entry: LiveLog, errorData: unknown): Promise<void> => {
    const previous = NoSessionPreviousSchema.safeParse(errorData).data?.previous;

    await writeEnd(entry, toPreviousEnd(previous, entry.generation));
  };

  const openEntryTap = async (imp: SessionLogImp, entry: LiveLog, life: number): Promise<void> => {
    const meta = entry.log.readMeta();
    const logEnd = readGenerationBounds(meta).logEnd;

    const resumeFrom =
      meta.segments.length === 0 && logEnd === 0
        ? undefined
        : { executionGeneration: entry.generation, offset: logEnd };

    let tap: ExecStream;

    try {
      tap = await openTap(imp.vsockPath, entry.session, resumeFrom);
    } catch (error) {
      // destroyed meanwhile: the slot under the key may be the imp's next life's
      if (isForgotten(imp.id, life)) {
        return;
      }

      taps.delete(entry.key);

      if (error instanceof AgentError && ['NO_SESSION', 'BAD_REQUEST'].includes(error.code)) {
        await writeGoneEnd(entry, error.data);

        return;
      }

      throw error;
    }

    if (isForgotten(imp.id, life)) {
      tap.close();

      return;
    }

    const output = tap.output?.continuity === 'offsets' ? tap.output : null;
    const resume = output?.resume;

    if (resume?.kind === 'generation_changed') {
      taps.delete(entry.key);

      await startNextGeneration(imp, entry, tap, life);

      return;
    }

    if (resume?.kind === 'gap') {
      entry.log.skipTo(resume.to);
    } else if (resumeFrom === undefined && output !== null) {
      entry.log.setOrigin(output.offset);
    }

    // the log went while the tap opened: a delete, a destroy
    if (taps.get(entry.key) !== 'opening') {
      tap.close();

      return;
    }

    taps.set(entry.key, tap);

    await runTap(imp, entry, tap);
  };

  const startTap = async (
    imp: SessionLogImp,
    session: Readonly<TappedSession>,
    life: number,
  ): Promise<void> => {
    const generation = session.execution_generation;
    const bootId = session.boot_id;

    if (generation === undefined || bootId === undefined) {
      return;
    }

    if (!isAgentLogIdentity({ generation, session: session.name, bootId })) {
      return;
    }

    const key = findKey(imp.id, generation);

    if (dropped.has(key) || isTapped(key)) {
      return;
    }

    taps.set(key, 'opening');

    try {
      let entry = live.get(key);

      if (entry === undefined) {
        // an ended log is not written again
        if (readGenerationMeta(findGenerationDir(imp.sessionLogsDir, generation)) !== null) {
          taps.delete(key);

          return;
        }

        const created = await createLiveLog(imp, generation, session.name, bootId, life);

        if (created === null) {
          taps.delete(key);

          return;
        }

        entry = created;
      }

      if (isForgotten(imp.id, life)) {
        taps.delete(key);

        return;
      }

      await openEntryTap(imp, entry, life);
    } catch (error) {
      if (taps.get(key) === 'opening') {
        taps.delete(key);
      }

      throw error;
    }
  };

  const runInBackground = (imp: SessionLogImp, task: () => Promise<void>): void => {
    void (async () => {
      try {
        await task();
      } catch (error) {
        printError(imp, error);
      }
    })();
  };

  const stopImpLogs = async (imp: SessionLogImp): Promise<void> => {
    await loadImpLogs(imp, readLife(imp.id));

    for (const entry of listLive(imp.id)) {
      await writeEnd(entry, {});
    }

    // the VM is gone, and every generation it ran with it
    for (const generation of listTombstones(imp.sessionLogsDir)) {
      removeTombstone(imp.sessionLogsDir, generation);
    }
  };

  const removeExpired = (imp: SessionLogImp, cutoff: number): void => {
    for (const meta of readImpMetas(imp.sessionLogsDir, readLive(imp.id))) {
      if (meta.state === 'ended' && (meta.endedAt ?? 0) < cutoff) {
        removeGenerationDir(imp.sessionLogsDir, meta.executionGeneration);
      }
    }
  };

  return {
    observe: (imp, sessions) => {
      const life = readLife(imp.id);

      if (imp.state !== 'running' || isForgotten(imp.id, life)) {
        return;
      }

      runInBackground(imp, async () => {
        await loadImpLogs(imp, life);

        const listed = new Set(sessions.map((session) => session.execution_generation));

        // a deleted generation that is gone can never be tapped again
        for (const generation of listTombstones(imp.sessionLogsDir)) {
          if (!listed.has(generation)) {
            removeTombstone(imp.sessionLogsDir, generation);
          }
        }

        for (const entry of listLive(imp.id)) {
          if (!listed.has(entry.generation) && !isTapped(entry.key)) {
            await writeEnd(entry, {});
          }
        }

        const logged = sessions.filter((session) => session.log === true);

        await Promise.all(logged.map((session) => startTap(imp, session, life)));
      });
    },

    tapNow: (imp, session) => {
      const life = readLife(imp.id);

      runInBackground(imp, async () => {
        await loadImpLogs(imp, life);
        await startTap(imp, session, life);
      });
    },

    endImp: stopImpLogs,

    forgetImp: (impId) => {
      forgotten.add(impId);
      lives.set(impId, readLife(impId) + 1);

      for (const entry of listLive(impId)) {
        stopTap(entry.key);

        entry.log.abandon();
        live.delete(entry.key);
      }

      // a tap on its way finds its slot gone and closes
      for (const key of [...taps.keys()].filter((each) => each.startsWith(`${impId}/`))) {
        stopTap(key);
      }

      recovered.delete(impId);
      uncheckedBytes.delete(impId);
    },

    admitImp: (impId) => {
      forgotten.delete(impId);
    },

    listLogs: (imp, session) =>
      readImpMetas(imp.sessionLogsDir, readLive(imp.id))
        .filter((meta) => session === undefined || meta.session === session)
        .toSorted((a, b) => b.startedAt - a.startedAt)
        .map((meta) => toApiSessionLog(meta)),

    readLog: (imp, request) => readSessionLogRange(imp.sessionLogsDir, readLive(imp.id), request),

    deleteLogs: (imp, target) => {
      const doomed = readImpMetas(imp.sessionLogsDir, readLive(imp.id)).filter(
        (meta) =>
          (target.session === undefined || meta.session === target.session) &&
          (target.executionGeneration === undefined ||
            meta.executionGeneration === target.executionGeneration),
      );

      for (const meta of doomed) {
        const key = findKey(imp.id, meta.executionGeneration);
        const entry = live.get(key);

        if (entry !== undefined) {
          stopTap(key);

          entry.log.abandon();
          live.delete(key);
          dropped.add(key);

          // a restarted impd must not tap it again
          writeTombstone(imp.sessionLogsDir, meta.executionGeneration);
        }

        removeGenerationDir(imp.sessionLogsDir, meta.executionGeneration);
      }

      return doomed.length;
    },

    sweep: async (imps) => {
      const cutoff = deps.now() - deps.limits.maxAgeMs;

      for (const imp of imps) {
        try {
          if (imp.state !== 'running' && imp.state !== 'sleeping') {
            await stopImpLogs(imp);
          }

          removeExpired(imp, cutoff);
        } catch (error) {
          printError(imp, error);
        }
      }
    },
  };
}
