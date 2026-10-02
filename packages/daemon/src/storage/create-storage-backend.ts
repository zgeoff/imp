import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config';
import type { StorageBackend, StorageBackendKind } from './storage-backend';
import { createXfsBackend } from './xfs-backend';
import { createZfsBackend } from './zfs/zfs-backend';

// names the backend that wrote the data dir; a switch would orphan every disk
const MARKER_FILE = 'storage-backend';

export function createStorageBackend(config: Config): StorageBackend {
  checkStorageMarker(config.dataDir, config.storageBackend);

  if (config.storageBackend === 'zfs' && config.zfsRoot !== null) {
    return createZfsBackend({ dataDir: config.dataDir, root: config.zfsRoot });
  }

  return createXfsBackend({ dataDir: config.dataDir });
}

// Refuses a data dir another backend wrote, and marks a new one.
export function checkStorageMarker(dataDir: string, kind: StorageBackendKind): void {
  const marker = join(dataDir, MARKER_FILE);
  const isMarked = existsSync(marker);
  const recorded = isMarked ? readFileSync(marker, 'utf8').trim() : readUnmarked(dataDir);

  if (recorded !== null && recorded !== kind) {
    throw new Error(
      `${dataDir} holds ${recorded} storage, but IMP_STORAGE_BACKEND is ${kind}; moving imps between backends is not supported`,
    );
  }

  if (!isMarked) {
    writeFileSync(marker, `${kind}\n`);
  }
}

// every data dir from before the marker is XFS; an empty one is new
function readUnmarked(dataDir: string): StorageBackendKind | null {
  const imps = join(dataDir, 'imps');
  const hasImps = existsSync(imps) && readdirSync(imps).length > 0;

  return hasImps ? 'xfs' : null;
}
