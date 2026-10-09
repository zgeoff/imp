import type { StorageBackend } from '../storage/storage-backend';

// A storage backend's faults, as a disk that cannot be read for a move: the
// wrapped backend answers every call, except that the next openMoveSource
// after failOnce rejects with the given error, without reaching it.
export function buildStubStorageFaults() {
  const pending: { openMoveSource: Error | null } = { openMoveSource: null };

  return {
    wrap: (backend: StorageBackend): StorageBackend => ({
      ...backend,
      openMoveSource: (impId, checkpointIds, mode) => {
        const error = pending.openMoveSource;

        if (error === null) {
          return backend.openMoveSource(impId, checkpointIds, mode);
        }

        pending.openMoveSource = null;

        return Promise.reject(error);
      },
    }),
    failOnce: (method: 'openMoveSource', error: Error) => {
      pending[method] = error;
    },
  };
}
