import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as z from 'zod';
import { BACKUP_TREE, buildBackupPaths, buildImagePaths, buildImpPaths } from './data-layout';
import { createReflinkClone } from './reflink';
import type { DiskSource, StorageBackend } from './storage-backend';

// The source disk of each copy in the backup tree. A sleeping or stopped
// imp's disk with the same inode and ctime is unchanged since, so the copy
// stays, and restic sees the file it read last run.
const CopiesSchema = z.record(
  z.string(),
  z.object({ ino: z.string(), ctimeNs: z.string(), size: z.string() }),
);

type Copies = z.infer<typeof CopiesSchema>;

// an image directory being written, renamed into place once complete
const STAGING_PREFIX = '.new-';

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

    if (source.kind === 'checkpoint') {
      return buildCheckpointDisk(source.impId, source.checkpointId);
    }

    throw new Error('xfs: an empty disk has no source file');
  };

  const backup = buildBackupPaths(deps.dataDir);

  // this run's copies of running disks: new every run, so none outlives it
  const freshCopies = new Set<string>();

  const readCopies = (): Copies => {
    try {
      return CopiesSchema.parse(JSON.parse(readFileSync(backup.copies, 'utf8')));
    } catch {
      return {};
    }
  };

  const writeCopies = (copies: Readonly<Copies>): void => {
    mkdirSync(backup.dir, { recursive: true });
    writeFileSync(`${backup.copies}.new`, JSON.stringify(copies));
    renameSync(`${backup.copies}.new`, backup.copies);
  };

  // a clone made once: checkpoints and images never change
  const createTreeClone = async (source: string, target: string): Promise<boolean> => {
    if (!existsSync(source)) {
      return false;
    }

    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });

      await cloneFile(source, `${target}.new`);

      renameSync(`${target}.new`, target);
    }

    return true;
  };

  return {
    kind: 'xfs',

    // an image build that a crash cut short leaves its staging dir
    start: () => {
      const imagesDir = join(deps.dataDir, 'images');
      const names = existsSync(imagesDir) ? readdirSync(imagesDir) : [];

      for (const name of names.filter((entry) => entry.startsWith(STAGING_PREFIX))) {
        rmSync(join(imagesDir, name), { recursive: true, force: true });
      }

      return Promise.resolve();
    },
    resolveImpPaths,

    createImage: async (digest, write) => {
      const paths = buildImagePaths(deps.dataDir, digest);
      const staged = join(deps.dataDir, 'images', `${STAGING_PREFIX}${Bun.randomUUIDv7()}`);

      mkdirSync(staged, { recursive: true });

      try {
        await write(staged);

        // impd before the storage backends wrote config.json first, so a
        // crash could leave the directory with no rootfs
        if (!existsSync(paths.rootfs)) {
          rmSync(paths.dir, { recursive: true, force: true });
        }

        renameSync(staged, paths.dir);
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

      if (source.kind === 'empty') {
        writeFileSync(disk, '');

        return;
      }

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

    createBackupCopy: async (impId, _runId, options) => {
      const source = resolveImpPaths(impId).disk;
      const target = join(backup.tree, BACKUP_TREE.buildDisk(impId));
      const stats = statSync(source, { bigint: true });

      const record = {
        ino: String(stats.ino),
        ctimeNs: String(stats.ctimeNs),
        size: String(stats.size),
      };

      const copies = readCopies();
      const last = copies[impId];

      const isUnchanged =
        last?.ino === record.ino && last.ctimeNs === record.ctimeNs && last.size === record.size;

      if (options.isReusable && isUnchanged && existsSync(target)) {
        return;
      }

      mkdirSync(dirname(target), { recursive: true });
      rmSync(`${target}.new`, { force: true });

      await cloneFile(source, `${target}.new`);

      renameSync(`${target}.new`, target);

      if (options.isReusable) {
        writeCopies({ ...copies, [impId]: record });
      } else {
        freshCopies.add(impId);
      }
    },

    // the tree stays between runs, so restic finds each file it read before
    openBackupTree: async (request) => {
      const impIds = new Set<string>();
      const checkpointIds = new Set<string>();
      const imageDigests = new Set<string>();

      for (const imp of request.imps) {
        if (!existsSync(join(backup.tree, BACKUP_TREE.buildDisk(imp.impId)))) {
          continue;
        }

        impIds.add(imp.impId);

        for (const checkpointId of imp.checkpointIds) {
          const isCopied = await createTreeClone(
            buildCheckpointDisk(imp.impId, checkpointId),
            join(backup.tree, BACKUP_TREE.buildCheckpointDisk(imp.impId, checkpointId)),
          );

          if (isCopied) {
            checkpointIds.add(checkpointId);
          }
        }

        removeUnlisted(
          join(backup.tree, BACKUP_TREE.buildImpDir(imp.impId), 'checkpoints'),
          new Set(imp.checkpointIds.filter((id) => checkpointIds.has(id))),
        );
      }

      for (const digest of request.imageDigests) {
        const source = buildImagePaths(deps.dataDir, digest);
        const dir = join(backup.tree, BACKUP_TREE.buildImageDir(digest));

        const isCopied = await createTreeClone(source.rootfs, join(dir, 'rootfs.ext4'));

        if (isCopied) {
          copyFileSync(source.config, join(dir, 'config.json'));

          imageDigests.add(digest);
        }
      }

      removeUnlisted(join(backup.tree, 'imps'), impIds);

      removeUnlisted(
        join(backup.tree, 'images'),
        new Set([...imageDigests].map((digest) => basename(BACKUP_TREE.buildImageDir(digest)))),
      );

      const copies = readCopies();

      writeCopies(Object.fromEntries(Object.entries(copies).filter(([id]) => impIds.has(id))));

      // a running disk's copy would pin the blocks it shares until next run
      const removeFreshCopies = () => {
        for (const impId of freshCopies) {
          rmSync(join(backup.tree, BACKUP_TREE.buildDisk(impId)), { force: true });
        }

        freshCopies.clear();

        return Promise.resolve();
      };

      return { impIds, checkpointIds, imageDigests, close: removeFreshCopies };
    },

    stop: () => Promise.resolve(),

    readUsage: () => {
      const stats = statfsSync(deps.dataDir);

      return Promise.resolve({
        usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
        availableBytes: stats.bavail * stats.bsize,
      });
    },
  };
}

// drops each entry of `dir` that `keep` does not name
function removeUnlisted(dir: string, keep: ReadonlySet<string>): void {
  const names = existsSync(dir) ? readdirSync(dir) : [];

  for (const name of names.filter((entry) => !keep.has(entry))) {
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}
