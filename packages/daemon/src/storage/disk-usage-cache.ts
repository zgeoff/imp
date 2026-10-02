import { listCheckpoints } from '../db/checkpoints';
import { listImps } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { readErrorMessage } from '../read-error-message';
import type { ImpDiskUsage, StorageBackend } from './storage-backend';

// a create or a destroy asks for a pass; this many ms later it runs, so a
// burst of them costs one
const REFRESH_DELAY_MS = 10_000;

export interface CachedDiskUsage extends ImpDiskUsage {
  readonly measuredAt: Date;
  readonly isPartial: boolean;
}

export interface DiskUsageCache {
  // a whole pass; one at a time
  readonly runPass: () => Promise<void>;
  readonly requestRefresh: () => void;
  readonly read: (impId: string) => CachedDiskUsage | undefined;
  readonly stop: () => void;
}

interface DiskUsageCacheDeps {
  readonly db: ImpDatabase;
  readonly storage: Pick<StorageBackend, 'measureUsage'>;
  readonly log: (message: string) => void;
  readonly now?: () => Date;
}

// Usage is slow to measure on XFS (FIEMAP over every file), so `imp ls` and
// `imp info` read the last pass, with its time.
export function createDiskUsageCache(deps: DiskUsageCacheDeps): DiskUsageCache {
  const now = deps.now ?? (() => new Date());

  const state = {
    usage: new Map<string, CachedDiskUsage>(),
    running: null as Promise<void> | null,
    timer: null as ReturnType<typeof setTimeout> | null,
  };

  const readUsagePass = async (): Promise<void> => {
    try {
      const imps = await listImps(deps.db);

      const listed = await Promise.all(
        imps.map(async (imp) => {
          const checkpoints = await listCheckpoints(deps.db, imp.id);

          return { impId: imp.id, checkpointIds: checkpoints.map((checkpoint) => checkpoint.id) };
        }),
      );

      const report = await deps.storage.measureUsage(listed);

      const measuredAt = now();

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

  return {
    runPass: runOnePass,
    requestRefresh: () => {
      state.timer ??= setTimeout(() => {
        state.timer = null;
        void runOnePass();
      }, REFRESH_DELAY_MS);
    },
    read: (impId) => state.usage.get(impId),
    stop: () => {
      if (state.timer !== null) {
        clearTimeout(state.timer);

        state.timer = null;
      }
    },
  };
}
