import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config';
import type { StorageBackend, StorageBackendKind } from './storage-backend';
import { createXfsBackend } from './xfs-backend';
import { createZfsBackend } from './zfs/zfs-backend';
import type { ZfsBackendDeps } from './zfs/zfs-backend';

// names the backend that wrote the data dir; a switch would orphan every disk
const MARKER_FILE = 'storage-backend';

// as ZFS's <root>/reserve: a destroy still runs on a full filesystem
const XFS_RESERVE_FILE_BYTES = 1024 ** 3;

// The host boundaries each backend takes; the host's own by default
interface StorageBoundaries {
  // tests on a tmpfs set 0
  readonly xfsReserveFileBytes?: number;

  // `zfs`, its streams, the mount table and the module's version
  readonly zfs?: Omit<ZfsBackendDeps, 'dataDir' | 'root'>;
}

// The marker is written once start succeeds: on ZFS, start checks that the
// dataset is mounted on the data dir, so the marker never lands under it.
export function createStorageBackend(
  config: Config,
  boundaries: Readonly<StorageBoundaries> = {},
): StorageBackend {
  checkStorageMarker(config.dataDir, config.storageBackend);

  const backend = buildBackend(config, boundaries);

  return {
    ...backend,
    start: async (live) => {
      await backend.start(live);

      writeStorageMarker(config.dataDir, config.storageBackend);
    },
  };
}

function buildBackend(config: Config, boundaries: Readonly<StorageBoundaries>): StorageBackend {
  if (config.storageBackend === 'xfs') {
    return createXfsBackend({
      dataDir: config.dataDir,
      reserveFileBytes: boundaries.xfsReserveFileBytes ?? XFS_RESERVE_FILE_BYTES,
    });
  }

  if (config.zfsRoot === null) {
    throw new Error('IMP_STORAGE_BACKEND=zfs needs IMP_ZFS_ROOT');
  }

  return createZfsBackend({ ...boundaries.zfs, dataDir: config.dataDir, root: config.zfsRoot });
}

// Refuses a data dir another backend wrote.
export function checkStorageMarker(dataDir: string, kind: StorageBackendKind): void {
  const marker = join(dataDir, MARKER_FILE);
  const recorded = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : readUnmarked(dataDir);

  if (recorded !== null && recorded !== kind) {
    throw new Error(
      `${dataDir} holds ${recorded} storage, but IMP_STORAGE_BACKEND is ${kind}; moving imps between backends is not supported`,
    );
  }
}

export function writeStorageMarker(dataDir: string, kind: StorageBackendKind): void {
  const marker = join(dataDir, MARKER_FILE);

  if (!existsSync(marker)) {
    writeFileSync(marker, `${kind}\n`);
  }
}

// every data dir from before the marker is XFS; an empty one is new
function readUnmarked(dataDir: string): StorageBackendKind | null {
  const imps = join(dataDir, 'imps');
  const hasImps = existsSync(imps) && readdirSync(imps).length > 0;

  return hasImps ? 'xfs' : null;
}
