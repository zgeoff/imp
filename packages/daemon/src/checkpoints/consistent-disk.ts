import { sendFreeze, sendThaw } from '../agent-client/agent-requests';
import { buildInvalidStateError } from '../api-errors';
import type { LockedImp } from '../imps/imp-lock';
import type { ImpCheckpointHooks } from '../imps/imp-service';
import { readErrorMessage } from '../read-error-message';
import type { StorageBackend } from '../storage/storage-backend';

// How long the guest stays frozen at most if impd never sends thaw.
export const FREEZE_TIMEOUT_MS = 10_000;

// the agent's freeze and thaw, behind an interface for tests
export interface DiskFreezer {
  readonly freeze: (vsockPath: string, timeoutMs: number) => Promise<void>;
  readonly thaw: (vsockPath: string) => Promise<void>;
}

interface ConsistentDiskDeps {
  readonly storage: Pick<StorageBackend, 'resolveImpPaths'>;
  readonly imps: Pick<ImpCheckpointHooks, 'requireRunningImp'>;
  readonly log: (message: string) => void;
  readonly freezer?: DiskFreezer | undefined;
}

// Runs `task` on a consistent disk: a running one is frozen around it (sync
// + FIFREEZE in the guest), a sleeping one wakes first, since its memory
// image holds unwritten page cache. The caller holds the imp's lock.
export type WithConsistentDisk = <T>(
  found: LockedImp,
  action: string,
  task: () => Promise<T>,
) => Promise<T>;

export function createConsistentDisk(deps: ConsistentDiskDeps): WithConsistentDisk {
  const freezer = deps.freezer ?? { freeze: sendFreeze, thaw: sendThaw };

  return async (found, action, task) => {
    const paths = deps.storage.resolveImpPaths(found.id);

    if (found.state === 'stopped' || found.state === 'error') {
      return task();
    }

    const imp = found.state === 'sleeping' ? await deps.imps.requireRunningImp(found) : found;

    if (imp.state !== 'running') {
      throw buildInvalidStateError(imp.state, ['running', 'stopped', 'error'], action);
    }

    try {
      await freezer.freeze(paths.vsockSocket, FREEZE_TIMEOUT_MS);

      return await task();
    } finally {
      try {
        await freezer.thaw(paths.vsockSocket);
      } catch (error) {
        const message = readErrorMessage(error);

        deps.log(`impd: ${imp.name}: thaw failed (the agent thaws on its own): ${message}`);
      }
    }
  };
}
