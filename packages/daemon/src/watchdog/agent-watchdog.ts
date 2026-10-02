import type { ImpRecord } from '../db/imps';

const HOUR_MS = 3_600_000;

// the first recovery may follow the report at once; each later one in the
// same hour waits twice as long as the one before
const FIRST_BACKOFF_MS = 60_000;
const MAX_RECOVERIES_PER_HOUR = 3;

export type WatchdogAction = 'report' | 'restart' | 'snapshot';

interface AgentWatchdogDeps {
  readonly timeoutMs: number;
  readonly action: WatchdogAction;
  readonly now: () => number;
  readonly log: (message: string) => void;

  // a longer ping than the idle loop's; true when the agent still says nothing
  readonly confirmSilent: (imp: ImpRecord) => Promise<boolean>;

  // kills the VM and boots it cold, first keeping its memory for `snapshot`;
  // false when another operation held the imp
  readonly recover: (imp: ImpRecord, action: 'restart' | 'snapshot') => Promise<boolean>;
}

// Watches the agents the idle loop asks for their activity: one silent past
// the timeout and a longer ping is reported, then recovered by the policy,
// at most three times an hour with a growing wait.
export interface AgentWatchdog {
  // the idle loop's activity answer for a running imp nothing holds
  readonly observe: (imp: ImpRecord, answered: boolean) => void;

  // the imp is held, asleep or gone: its silence no longer counts
  readonly forget: (id: string) => void;

  // when its agent went silent, once that is reported
  readonly readSilentSince: (id: string) => Date | null;

  // resolves once the checks and recoveries under way have finished
  readonly settle: () => Promise<void>;
}

export function createAgentWatchdog(deps: AgentWatchdogDeps): AgentWatchdog {
  // per imp: when its agent went silent; which of those are reported, and
  // which ran out of recoveries this hour
  const silences = new Map<string, number>();
  const reported = new Set<string>();
  const capped = new Set<string>();
  const recoveries = new Map<string, number[]>();
  const running = new Map<string, Promise<void>>();

  // when the next recovery may run; null once the hour's are spent
  const findNextRecovery = (id: string): number | null => {
    const recent = (recoveries.get(id) ?? []).filter((at) => at > deps.now() - HOUR_MS);

    recoveries.set(id, recent);

    const last = recent.at(-1);

    if (last === undefined) {
      return deps.now();
    }

    if (recent.length >= MAX_RECOVERIES_PER_HOUR) {
      return null;
    }

    return last + FIRST_BACKOFF_MS * 2 ** (recent.length - 1);
  };

  const removeSilence = (id: string): void => {
    silences.delete(id);
    reported.delete(id);
    capped.delete(id);
  };

  const checkSilence = async (imp: ImpRecord, since: number): Promise<void> => {
    const silent = await deps.confirmSilent(imp);

    if (!silent) {
      removeSilence(imp.id);

      return;
    }

    // it answered, or went away, while the ping ran
    if (silences.get(imp.id) !== since) {
      return;
    }

    if (!reported.has(imp.id)) {
      reported.add(imp.id);

      const silentS = Math.round((deps.now() - since) / 1000);

      deps.log(
        `impd: ${imp.name}: the agent has not answered for ${String(silentS)}s; its VM still runs (watchdog: ${deps.action})`,
      );
    }

    if (deps.action === 'report') {
      return;
    }

    const next = findNextRecovery(imp.id);

    if (next === null) {
      if (!capped.has(imp.id)) {
        capped.add(imp.id);

        deps.log(
          `impd: ${imp.name}: the watchdog recovered it ${String(MAX_RECOVERIES_PER_HOUR)} times this hour; it only reports now`,
        );
      }

      return;
    }

    if (deps.now() < next) {
      return;
    }

    const startedAt = deps.now();

    const recovered = await deps.recover(imp, deps.action);

    // a cold boot starts a new agent: its silence starts over. One that
    // another operation held off does not count.
    if (recovered) {
      recoveries.get(imp.id)?.push(startedAt);
      removeSilence(imp.id);
    }
  };

  // checkSilence, and forgotten as running once it ends
  const runCheck = async (imp: ImpRecord, since: number): Promise<void> => {
    try {
      await checkSilence(imp, since);
    } finally {
      running.delete(imp.id);
    }
  };

  return {
    observe: (imp, answered) => {
      if (answered) {
        if (reported.has(imp.id)) {
          deps.log(`impd: ${imp.name}: the agent answers again`);
        }

        removeSilence(imp.id);

        return;
      }

      const since = silences.get(imp.id) ?? deps.now();

      silences.set(imp.id, since);

      if (deps.now() - since < deps.timeoutMs || running.has(imp.id)) {
        return;
      }

      running.set(imp.id, runCheck(imp, since));
    },

    forget: removeSilence,

    readSilentSince: (id) => {
      const since = silences.get(id);

      return since !== undefined && reported.has(id) ? new Date(since) : null;
    },

    settle: async () => {
      await Promise.all(running.values());
    },
  };
}
