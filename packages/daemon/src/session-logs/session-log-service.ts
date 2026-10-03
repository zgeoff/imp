import type { PreviousGeneration, ResumeFrom, SessionLog, SessionLogRead } from '@imp/api';
import { PreviousGenerationSchema } from '@imp/api';
import * as z from 'zod';
import { AgentError } from '../agent-client/agent-connection';
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
  readImpMetas,
  readSessionLogRange,
  removeGenerationDir,
  toApiSessionLog,
} from './session-log-files';
import type { SessionLogReadRequest } from './session-log-files';

// Session logs (docs/architecture/daemon.md#session-logs). impd taps each
// session the agent marks `log`, beside its viewer, and writes its output
// under the imp's directory. Each look at the sessions taps what is untapped.

export interface SessionLogLimits {
  // one generation's log, of which it keeps at least half the newest
  readonly generationMaxBytes: number;

  // an imp's logs together; ended generations go first, oldest first
  readonly impMaxBytes: number;

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

  const live = new Map<string, LiveLog>();

  // each live log's tap, or `opening` while one is on its way
  const taps = new Map<string, Readonly<ExecStream> | 'opening'>();

  // never tapped again in this impd's life: deleted while live, or stopped
  const dropped = new Set<string>();

  // imps whose directory this impd has read since it started
  const recovered = new Set<string>();

  const buildOptions = (imp: SessionLogImp, generation: string): GenerationLogOptions => ({
    dir: findGenerationDir(imp.sessionLogsDir, generation),
    segmentBytes,
    maxBytes: deps.limits.generationMaxBytes,
    requireRoom: deps.requireRoom,
    now: deps.now,
    log: deps.log,
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
  const loadImpLogs = async (imp: SessionLogImp): Promise<void> => {
    if (recovered.has(imp.id)) {
      return;
    }

    recovered.add(imp.id);

    for (const meta of readImpMetas(imp.sessionLogsDir, readLive(imp.id))) {
      const key = findKey(imp.id, meta.executionGeneration);

      if (meta.state === 'live' && !live.has(key)) {
        const options = buildOptions(imp, meta.executionGeneration);

        const log = await loadGenerationLog(options, meta);

        setLive(imp, meta.executionGeneration, meta.session, log);

        if (meta.stopped !== undefined) {
          dropped.add(key);
        }
      }
    }
  };

  // ended logs go oldest first; then the largest live log gives up its
  // oldest segment
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
        return;
      }

      total = countImpBytes();
    }
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
    let segments = entry.log.readMeta().segments.length;

    try {
      for await (const event of tap.events()) {
        if (event.type === 'stdout') {
          await entry.log.append(event.data);

          const count = entry.log.readMeta().segments.length;

          if (count !== segments) {
            segments = count;

            await applyImpLimit(imp);
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
  ): Promise<void> => {
    const output = tap.output;

    if (output?.continuity !== 'offsets') {
      tap.close();

      return;
    }

    await writeEnd(entry, toPreviousEnd(output.previous, entry.generation));

    const key = findKey(imp.id, output.executionGeneration);
    const dir = findGenerationDir(imp.sessionLogsDir, output.executionGeneration);

    if (isTapped(key) || dropped.has(key) || readGenerationMeta(dir) !== null) {
      tap.close();

      return;
    }

    taps.set(key, tap);

    const log = await createGenerationLog(buildOptions(imp, output.executionGeneration), {
      session: entry.session,
      executionGeneration: output.executionGeneration,
      bootId: output.bootId,
    });

    log.setOrigin(output.offset);

    await runTap(imp, setLive(imp, output.executionGeneration, entry.session, log), tap);
  };

  // NO_SESSION or BAD_REQUEST (no longer logged): the generation ended
  const writeGoneEnd = async (entry: LiveLog, errorData: unknown): Promise<void> => {
    const previous = NoSessionPreviousSchema.safeParse(errorData).data?.previous;

    await writeEnd(entry, toPreviousEnd(previous, entry.generation));
  };

  const openEntryTap = async (imp: SessionLogImp, entry: LiveLog): Promise<void> => {
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
      taps.delete(entry.key);

      if (error instanceof AgentError && ['NO_SESSION', 'BAD_REQUEST'].includes(error.code)) {
        await writeGoneEnd(entry, error.data);

        return;
      }

      throw error;
    }

    const output = tap.output?.continuity === 'offsets' ? tap.output : null;
    const resume = output?.resume;

    if (resume?.kind === 'generation_changed') {
      taps.delete(entry.key);

      await startNextGeneration(imp, entry, tap);

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

  const startTap = async (imp: SessionLogImp, session: Readonly<TappedSession>): Promise<void> => {
    const generation = session.execution_generation;
    const bootId = session.boot_id;

    if (generation === undefined || bootId === undefined) {
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

        const log = await createGenerationLog(buildOptions(imp, generation), {
          session: session.name,
          executionGeneration: generation,
          bootId,
        });

        entry = setLive(imp, generation, session.name, log);
      }

      await openEntryTap(imp, entry);
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
    await loadImpLogs(imp);

    for (const entry of listLive(imp.id)) {
      await writeEnd(entry, {});
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
      if (imp.state !== 'running') {
        return;
      }

      runInBackground(imp, async () => {
        await loadImpLogs(imp);

        const listed = new Set(sessions.map((session) => session.execution_generation));

        for (const entry of listLive(imp.id)) {
          if (!listed.has(entry.generation) && !isTapped(entry.key)) {
            await writeEnd(entry, {});
          }
        }

        const logged = sessions.filter((session) => session.log === true);

        await Promise.all(logged.map((session) => startTap(imp, session)));
      });
    },

    tapNow: (imp, session) => {
      runInBackground(imp, async () => {
        await loadImpLogs(imp);
        await startTap(imp, session);
      });
    },

    endImp: stopImpLogs,

    forgetImp: (impId) => {
      for (const entry of listLive(impId)) {
        stopTap(entry.key);

        entry.log.abandon();
        live.delete(entry.key);
      }

      recovered.delete(impId);
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
