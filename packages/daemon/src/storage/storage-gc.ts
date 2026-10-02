import type { StorageGc } from '@imp/api';
import { ORPCError } from '@orpc/server';
import type { ImpDatabase } from '../db/open-database';
import { printSweep } from './print-sweep';
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

interface GcOptions {
  readonly isDryRun: boolean;
  readonly isOrphans: boolean;
}

export interface StorageGcService {
  readonly runGc: (options: GcOptions) => Promise<StorageGc>;
  readonly runScheduled: () => Promise<void>;
}

// The GC: the same sweep as start, while nothing that could make storage
// without its row yet is in flight (docs/architecture/storage.md#cleanup).
// Only `imp gc --orphans` takes orphans; the hourly pass logs them.
export function createStorageGc(deps: StorageGcDeps): StorageGcService {
  const runAlone = async (options: GcOptions, waitMs: number, isOrphansLogged: boolean) => {
    const result = await deps.storageGate.runAlone(async () => {
      const live = await readLiveStorage(deps.db);

      return deps.storage.dropUnnamed(live, options);
    }, waitMs);

    if (result.ran && !options.isDryRun) {
      printSweep(deps.log, 'impd: gc', result.value, { isOrphansLogged });
    }

    return result;
  };

  return {
    runGc: async (options) => {
      const result = await runAlone(options, MANUAL_WAIT_MS, false);

      if (!result.ran) {
        throw new ORPCError('PRECONDITION_FAILED', {
          message: `storage is busy (${String(deps.storageGate.countInFlight())} operations in flight, a backup run among them perhaps); try again`,
        });
      }

      return { dryRun: options.isDryRun, dropped: result.value.dropped, kept: result.value.kept };
    },
    runScheduled: async () => {
      const result = await runAlone({ isDryRun: false, isOrphans: false }, SCHEDULED_WAIT_MS, true);

      if (!result.ran) {
        deps.log('impd: gc: storage stayed busy; the next pass tries again');
      }
    },
  };
}
