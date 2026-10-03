import type { DroppedStorage, OrphanStorage, StorageGc } from '@imp/api';
import { ORPCError } from '@orpc/server';
import type { SecretFiles } from '../broker/secret-files';
import type { ImpDatabase } from '../db/open-database';
import { printSweep } from './print-sweep';
import type { OrphanLogging } from './print-sweep';
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

  // the secret values the broker kept aside (docs/guides/connectors.md#value-files)
  readonly secretFiles?: Pick<SecretFiles, 'listKept' | 'removeKept'>;
}

interface GcOptions {
  readonly isDryRun: boolean;
  readonly isOrphans: boolean;
}

// `isSecretFiles`: the caller asked for kind `secrets`, which an older
// client does not know
interface ManualGcOptions extends GcOptions {
  readonly isSecretFiles?: boolean;
}

export interface StorageGcService {
  readonly runGc: (options: ManualGcOptions) => Promise<StorageGc>;
  readonly runScheduled: () => Promise<void>;
}

// The GC: the same sweep as start, while nothing that could make storage
// without its row yet is in flight (docs/architecture/storage.md#cleanup).
// Only `imp gc --orphans` takes orphans.
export function createStorageGc(deps: StorageGcDeps): StorageGcService {
  const hourly = { lastKept: null as string | null };

  const runAlone = async (options: GcOptions, waitMs: number, isScheduled: boolean) => {
    const result = await deps.storageGate.runAlone(async () => {
      const live = await readLiveStorage(deps.db);

      return deps.storage.dropUnnamed(live, options);
    }, waitMs);

    if (result.ran && !options.isDryRun) {
      const kept = JSON.stringify(result.value.kept.map((orphan) => orphan.location));
      const isChanged = kept !== hourly.lastKept;

      // the hourly pass lists them when the set changed, else counts them
      const scheduledLogging: OrphanLogging = isChanged ? 'each' : 'count';
      const logging = isScheduled ? scheduledLogging : 'none';

      if (isScheduled) {
        hourly.lastKept = kept;
      }

      printSweep(deps.log, 'impd: gc', result.value, logging);
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

      const secrets = options.isSecretFiles === true ? removeSecretFiles(deps, options) : null;

      return {
        dryRun: options.isDryRun,
        dropped: [...result.value.dropped, ...(secrets?.dropped ?? [])],
        kept: [...result.value.kept, ...(secrets?.kept ?? [])],
      };
    },
    runScheduled: async () => {
      const result = await runAlone({ isDryRun: false, isOrphans: false }, SCHEDULED_WAIT_MS, true);

      if (!result.ran) {
        deps.log('impd: gc: storage stayed busy; the next pass tries again');
      }
    },
  };
}

// Each directory of secret values the broker kept aside: listed under
// `kept`, or with `orphans` removed (listed under `dropped` in a dry run).
function removeSecretFiles(
  deps: Readonly<StorageGcDeps>,
  options: Readonly<GcOptions>,
): { readonly dropped: DroppedStorage[]; readonly kept: OrphanStorage[] } {
  const kept = deps.secretFiles?.listKept() ?? [];

  if (!options.isOrphans) {
    return {
      dropped: [],
      kept: kept.map((entry) => ({
        kind: 'secrets',
        id: entry.name,
        location: entry.path,
        bytes: entry.bytes,
        createdAt: entry.createdAt,
        snapshots: [],
        files: entry.files,
      })),
    };
  }

  if (!options.isDryRun) {
    for (const entry of kept) {
      deps.secretFiles?.removeKept(entry.name);
      deps.log(`impd: gc: removed kept secret values ${entry.path}`);
    }
  }

  return { dropped: kept.map((entry) => ({ kind: 'secrets', id: entry.name })), kept: [] };
}
