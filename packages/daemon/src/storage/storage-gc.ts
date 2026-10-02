import type { StorageGc } from '@imp/api';
import { ORPCError } from '@orpc/server';
import type { ImpDatabase } from '../db/open-database';
import { readLiveStorage } from './read-live-storage';
import type { StorageBackend } from './storage-backend';
import type { StorageGate } from './storage-gate';

// `imp gc` waits this long for the operations in flight; the hourly pass
// waits longer, then skips the hour
const MANUAL_WAIT_MS = 30_000;
const SCHEDULED_WAIT_MS = 600_000;

interface StorageGcDeps {
  readonly db: ImpDatabase;
  readonly storage: Pick<StorageBackend, 'dropUnnamed'>;
  readonly storageGate: StorageGate;
  readonly log: (message: string) => void;
}

export interface StorageGcService {
  readonly runGc: (isDryRun: boolean) => Promise<StorageGc>;
  readonly runScheduled: () => Promise<void>;
}

// The GC: the same sweep as start, while nothing that could make storage
// without its row yet is in flight (docs/architecture/storage.md#cleanup).
export function createStorageGc(deps: StorageGcDeps): StorageGcService {
  const runAlone = async (isDryRun: boolean, waitMs: number) => {
    const result = await deps.storageGate.runAlone(async () => {
      const live = await readLiveStorage(deps.db);

      return deps.storage.dropUnnamed(live, { isDryRun });
    }, waitMs);

    if (result.ran && !isDryRun) {
      for (const dropped of result.value) {
        deps.log(`impd: gc: removed ${dropped.kind} ${dropped.id}`);
      }
    }

    return result;
  };

  return {
    runGc: async (isDryRun) => {
      const result = await runAlone(isDryRun, MANUAL_WAIT_MS);

      if (!result.ran) {
        throw new ORPCError('PRECONDITION_FAILED', {
          message: `storage is busy (${String(deps.storageGate.countInFlight())} operations in flight, a backup run among them perhaps); try again`,
        });
      }

      return { dryRun: isDryRun, dropped: result.value };
    },
    runScheduled: async () => {
      const result = await runAlone(false, SCHEDULED_WAIT_MS);

      if (!result.ran) {
        deps.log('impd: gc: storage stayed busy; the next pass tries again');
      }
    },
  };
}
