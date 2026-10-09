import { existsSync, writeFileSync } from 'node:fs';
import type { StorageBackend } from '../storage/storage-backend';
import { createZfsBackend } from '../storage/zfs/zfs-backend';
import { buildStubZfs } from './build-stub-zfs';
import type { StubZfs } from './build-stub-zfs';

// An impd's ZFS storage on buildStubZfs's pool under `root`, for a harness's
// `createStorage`. The stub pool keeps no file data, so the backend writes a
// disk file wherever a clone or a received stream would have left one.
export function buildStubZfsStorage(root: string) {
  const made: { pool: StubZfs | null } = { pool: null };

  const createStorage = (dataDir: string): StorageBackend => {
    const zfs = buildStubZfs({ root, rootDir: dataDir });

    made.pool = zfs;

    const backend = createZfsBackend({
      dataDir,
      root,
      run: zfs.run,
      streams: zfs.streams,
      readMounts: zfs.readMounts,
      readModuleVersion: () => '2.2.2-0ubuntu9',
      log: () => {},
    });

    const writeDisk = (impId: string) => {
      const disk = backend.resolveImpPaths(impId).disk;

      if (!existsSync(disk)) {
        writeFileSync(disk, 'disk');
      }
    };

    return {
      ...backend,
      createImpDisk: async (impId, source) => {
        await backend.createImpDisk(impId, source);

        writeDisk(impId);
      },
      receiveMoveSnapshots: async (impId, steps, readStep, buildId) => {
        const received = await backend.receiveMoveSnapshots(impId, steps, readStep, buildId);

        writeDisk(impId);

        return received;
      },
    };
  };

  // the pool, once the harness made the storage
  const readPool = (): StubZfs => {
    if (made.pool === null) {
      throw new Error('no pool: the storage was never made');
    }

    return made.pool;
  };

  return { createStorage, readPool };
}
