import type { ImpChangeReason } from '@imp/api';
import { listCheckpoints } from '../db/checkpoints';
import { listImps } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { readErrorMessage } from '../read-error-message';
import type { ImpDiskUsage, StorageBackend } from './storage-backend';

// a write that changes what an imp takes asks for a pass; this many ms later
// it runs, so a burst of them costs one
const REFRESH_DELAY_MS = 10_000;

// changes to an imp that change what it takes: a grown disk, a restored
// checkpoint, and a stop or a sleep, which writes the guest's cache and memory
// out
export const CHANGES_USAGE: ReadonlySet<ImpChangeReason> = new Set([
  'resized',
  'restored',
  'stopped',
  'slept',
]);

export interface CachedDiskUsage extends ImpDiskUsage {
  // when the pass started: the count holds every write before it
  readonly measuredAt: Date;
  readonly isPartial: boolean;
}

export interface DiskUsageCache {
  // a whole pass; one at a time
  readonly runPass: () => Promise<void>;
  readonly requestRefresh: () => void;
  readonly read: (impId: string) => CachedDiskUsage | undefined;

  // what the imps take on their own, together: what destroying each frees
  readonly readExclusiveTotal: () => number;
  readonly stop: () => void;
}

interface DiskUsageCacheDeps {
  readonly db: ImpDatabase;
  readonly storage: Pick<StorageBackend, 'measureUsage'>;
  readonly log: (message: string) => void;
  readonly now?: () => Date;
  readonly refreshDelayMs?: number;

  // runs `fire` once `ms` is up and returns the cancel; setTimeout by default
  readonly startTimer?: (fire: () => void, ms: number) => () => void;
}

function startRealTimer(fire: () => void, ms: number): () => void {
  const timer = setTimeout(fire, ms);

  return () => {
    clearTimeout(timer);
  };
}

// Usage is slow to measure on XFS (FIEMAP over every file), so `imp ls` and
// `imp info` read the last pass, with its time.
export function createDiskUsageCache(deps: DiskUsageCacheDeps): DiskUsageCache {
  const now = deps.now ?? (() => new Date());
  const refreshDelayMs = deps.refreshDelayMs ?? REFRESH_DELAY_MS;
  const startTimer = deps.startTimer ?? startRealTimer;

  const state = {
    usage: new Map<string, CachedDiskUsage>(),
    running: null as Promise<void> | null,

    // the pending refresh's cancel
    cancelRefresh: null as (() => void) | null,

    // set at shutdown: the sleeps that follow ask for passes nobody reads
    isStopped: false,
  };

  const readUsagePass = async (): Promise<void> => {
    const measuredAt = now();

    try {
      const imps = await listImps(deps.db);

      const listed = await Promise.all(
        imps.map(async (imp) => {
          const checkpoints = await listCheckpoints(deps.db, imp.id);

          return { impId: imp.id, checkpointIds: checkpoints.map((checkpoint) => checkpoint.id) };
        }),
      );

      const report = await deps.storage.measureUsage(listed);

      // an imp a cut-short pass did not reach keeps its last count and time
      const kept = listed.flatMap((imp) => {
        const usage = report.imps.get(imp.impId);
        const last = state.usage.get(imp.impId);

        if (usage !== undefined) {
          return [[imp.impId, { ...usage, measuredAt, isPartial: report.isPartial }] as const];
        }

        return last === undefined ? [] : [[imp.impId, last] as const];
      });

      state.usage = new Map(kept);
    } catch (error) {
      deps.log(`impd: disk usage: ${readErrorMessage(error)}`);
    }
  };

  const runOnePass = async (): Promise<void> => {
    if (state.running !== null) {
      return state.running;
    }

    state.running = readUsagePass();

    try {
      await state.running;
    } finally {
      state.running = null;
    }
  };

  const runAfterCurrent = async (): Promise<void> => {
    await state.running;

    if (!state.isStopped) {
      await runOnePass();
    }
  };

  return {
    runPass: runOnePass,

    // a pass under way may have measured before the write that asked, so
    // the refresh waits for it and runs its own
    requestRefresh: () => {
      if (state.isStopped) {
        return;
      }

      state.cancelRefresh ??= startTimer(() => {
        state.cancelRefresh = null;
        void runAfterCurrent();
      }, refreshDelayMs);
    },
    read: (impId) => state.usage.get(impId),
    readExclusiveTotal: () =>
      [...state.usage.values()].reduce((total, usage) => total + usage.exclusiveBytes, 0),
    stop: () => {
      state.isStopped = true;

      if (state.cancelRefresh !== null) {
        state.cancelRefresh();

        state.cancelRefresh = null;
      }
    },
  };
}
