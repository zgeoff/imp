import { mkdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildImagePaths, buildImpPaths } from './data-layout';
import { createReflinkClone } from './reflink';
import type { DiskSource, StorageBackend } from './storage-backend';

interface XfsBackendDeps {
  readonly dataDir: string;

  // a reflink clone by default; tests on a non-XFS tmpdir copy instead
  readonly cloneFile?: (source: string, target: string) => Promise<void>;
}

// Every disk, checkpoint and fork is a reflink clone of another file
// (docs/architecture/storage.md).
export function createXfsBackend(deps: XfsBackendDeps): StorageBackend {
  const cloneFile = deps.cloneFile ?? createReflinkClone;
  const resolveImpPaths = (impId: string) => buildImpPaths(deps.dataDir, impId);

  const buildCheckpointDisk = (impId: string, checkpointId: string): string =>
    join(resolveImpPaths(impId).checkpointsDir, checkpointId, 'disk.ext4');

  const findSourceFile = (source: DiskSource): string => {
    if (source.kind === 'image') {
      return buildImagePaths(deps.dataDir, source.digest).rootfs;
    }

    if (source.kind === 'imp') {
      return resolveImpPaths(source.impId).disk;
    }

    return buildCheckpointDisk(source.impId, source.checkpointId);
  };

  return {
    kind: 'xfs',
    start: () => Promise.resolve(),
    resolveImpPaths,

    createImage: async (digest, write) => {
      const target = buildImagePaths(deps.dataDir, digest).dir;
      const staged = join(deps.dataDir, 'images', `.new-${Bun.randomUUIDv7()}`);

      mkdirSync(staged, { recursive: true });

      try {
        await write(staged);

        renameSync(staged, target);
      } finally {
        rmSync(staged, { recursive: true, force: true });
      }
    },

    removeImage: (digest) => {
      rmSync(buildImagePaths(deps.dataDir, digest).dir, { recursive: true, force: true });

      return Promise.resolve();
    },

    createImpDisk: async (impId, source) => {
      const disk = resolveImpPaths(impId).disk;

      mkdirSync(dirname(disk), { recursive: true });

      await cloneFile(findSourceFile(source), disk);
    },

    removeImpDisk: (impId) => {
      const paths = resolveImpPaths(impId);

      rmSync(paths.disk, { force: true });
      rmSync(paths.checkpointsDir, { recursive: true, force: true });

      return Promise.resolve();
    },

    createCheckpoint: async (impId, checkpointId) => {
      const disk = buildCheckpointDisk(impId, checkpointId);

      mkdirSync(dirname(disk), { recursive: true });

      try {
        await cloneFile(resolveImpPaths(impId).disk, disk);

        // allocated bytes of the clone; the extents it shares with the imp
        // disk count in full, so this is the most it can cost, not its cost
        return statSync(disk).blocks * 512;
      } catch (error) {
        rmSync(dirname(disk), { recursive: true, force: true });
        throw error;
      }
    },

    removeCheckpoint: (impId, checkpointId) => {
      rmSync(dirname(buildCheckpointDisk(impId, checkpointId)), { recursive: true, force: true });

      return Promise.resolve();
    },

    restoreCheckpoint: async (impId, checkpointId, halt) => {
      const disk = resolveImpPaths(impId).disk;
      const staged = `${disk}.new`;

      rmSync(staged, { force: true });

      try {
        await cloneFile(buildCheckpointDisk(impId, checkpointId), staged);

        const halted = await halt();

        renameSync(staged, disk);

        return halted;
      } finally {
        // gone after the swap; a clone or halt that failed leaves it behind
        rmSync(staged, { force: true });
      }
    },

    readUsage: () => {
      const stats = statfsSync(deps.dataDir);

      return Promise.resolve({
        usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
        availableBytes: stats.bavail * stats.bsize,
      });
    },
  };
}
