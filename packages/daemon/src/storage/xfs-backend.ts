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
import { printLog } from '../process/print-log';
import { runChecked } from '../process/run-command';
import { countOwnerBytes } from './count-owner-bytes';
import type { OwnedFile } from './count-owner-bytes';
import { BACKUP_TREE, buildBackupPaths, buildImagePaths, buildImpPaths } from './data-layout';
import { readExtents } from './fiemap';
import { readLoopHostFreeBytes } from './loop-backing-file';
import { createReflinkClone } from './reflink';
import type { DiskSource, DroppedStorage, LiveStorage, StorageBackend } from './storage-backend';

// The source disk of each copy in the backup tree. A sleeping or stopped
// imp's disk with the same inode and ctime is unchanged since, so the copy
// stays, and restic sees the file it read last run.
const CopiesSchema = z.record(
  z.string(),
  z.object({ ino: z.string(), ctimeNs: z.string(), size: z.string() }),
);

type Copies = z.infer<typeof CopiesSchema>;

// a usage pass stops here and reports what it read (fiemap.ts)
const USAGE_DEADLINE_MS = 20_000;

// an image directory being written, renamed into place once complete; a
// hidden name, as image-service's `.build-` work directories
const STAGING_PREFIX = '.new-';

interface XfsBackendDeps {
  readonly dataDir: string;

  // a reflink clone by default; tests on a non-XFS tmpdir copy instead
  readonly cloneFile?: (source: string, target: string) => Promise<void>;

  // Space start allocates to <dataDir>/reserve, so a destroy still runs on a
  // full filesystem; removing the file frees it. None by default.
  readonly reserveFileBytes?: number;
  readonly log?: (message: string) => void;

  // FIEMAP by default; tests cut a pass short with their own
  readonly readFileExtents?: typeof readExtents;
}

// Every disk, checkpoint and fork is a reflink clone of another file
// (docs/architecture/storage.md).
export function createXfsBackend(deps: XfsBackendDeps): StorageBackend {
  const cloneFile = deps.cloneFile ?? createReflinkClone;
  const log = deps.log ?? printLog;
  const readFileExtents = deps.readFileExtents ?? readExtents;
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

  const createImage = async (digest: string, write: (dir: string) => Promise<void>) => {
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

  // Image directories, imp directories and checkpoints the database does not
  // name. Hidden entries are image builds in flight, which only start drops.
  const planLeftovers = (live: LiveStorage): DroppedStorage[] => {
    const liveDigests = new Set(
      [...live.imageDigests].map((digest) => basename(buildImagePaths(deps.dataDir, digest).dir)),
    );

    const impIds = listEntries(join(deps.dataDir, 'imps'));

    const checkpoints = impIds
      .filter((impId) => live.impIds.has(impId))
      .flatMap((impId) => listEntries(resolveImpPaths(impId).checkpointsDir))
      .filter((checkpointId) => !live.checkpointIds.has(checkpointId));

    return [
      ...listEntries(join(deps.dataDir, 'images'))
        .filter((name) => !name.startsWith('.') && !liveDigests.has(name))
        .map((name) => ({ kind: 'image' as const, id: name })),
      ...impIds
        .filter((impId) => !live.impIds.has(impId))
        .map((impId) => ({ kind: 'imp' as const, id: impId })),
      ...checkpoints.map((checkpointId) => ({ kind: 'checkpoint' as const, id: checkpointId })),
    ];
  };

  const removeLeftover = (dropped: DroppedStorage, live: LiveStorage): void => {
    if (dropped.kind === 'image') {
      rmSync(join(deps.dataDir, 'images', dropped.id), { recursive: true, force: true });
    }

    if (dropped.kind === 'imp') {
      rmSync(resolveImpPaths(dropped.id).dir, { recursive: true, force: true });
    }

    if (dropped.kind === 'checkpoint') {
      for (const impId of live.impIds) {
        rmSync(join(resolveImpPaths(impId).checkpointsDir, dropped.id), {
          recursive: true,
          force: true,
        });
      }
    }
  };

  // Every file that holds disk blocks, with whoever removing it frees them.
  // The backup tree's reflinks hold blocks between runs, so it is an owner.
  const listImpFiles = (impId: string) => {
    const paths = resolveImpPaths(impId);

    const checkpoints = listEntries(paths.checkpointsDir).map((id) =>
      buildCheckpointDisk(impId, id),
    );

    return [paths.disk, ...checkpoints, paths.memFile, paths.vmstate]
      .filter((path) => existsSync(path))
      .map((path) => ({ owner: `imp:${impId}`, path }));
  };

  // the owners besides imps; the backup tree's reflinks hold blocks between
  // runs, so it is one
  const listOtherFiles = () => {
    const images = listEntries(join(deps.dataDir, 'images'))
      .filter((name) => !name.startsWith('.'))
      .map((name) => ({
        owner: `image:${name}`,
        path: join(deps.dataDir, 'images', name, 'rootfs.ext4'),
      }));

    const tree = listFilesUnder(backup.tree).map((path) => ({ owner: 'backup', path }));

    return [...images, ...tree].filter((file) => existsSync(file.path));
  };

  // the imp a pass cut short stopped at; the next pass starts there
  const usageState = { resumeImpId: null as string | null };

  // made once, and again at a start after someone removed it to free space,
  // when twice its size is free
  const setupReserveFile = async (): Promise<void> => {
    const bytes = deps.reserveFileBytes ?? 0;
    const file = join(deps.dataDir, 'reserve');

    if (bytes === 0 || existsSync(file)) {
      return;
    }

    const stats = statfsSync(deps.dataDir);

    if (stats.bavail * stats.bsize < 2 * bytes) {
      log(`impd: xfs: too little free space for the ${String(bytes)}-byte reserve file`);

      return;
    }

    await runChecked(['fallocate', '-l', String(bytes), `${file}.new`]);

    renameSync(`${file}.new`, file);
  };

  const removeUnnamed = (live: LiveStorage, isDryRun: boolean): DroppedStorage[] => {
    const dropped = planLeftovers(live);

    if (!isDryRun) {
      for (const leftover of dropped) {
        removeLeftover(leftover, live);
      }
    }

    return dropped;
  };

  return {
    kind: 'xfs',

    // an image build that a crash cut short leaves its staging dir
    start: (live) => {
      const imagesDir = join(deps.dataDir, 'images');

      for (const name of listEntries(imagesDir).filter((entry) => entry.startsWith('.'))) {
        rmSync(join(imagesDir, name), { recursive: true, force: true });
      }

      removeUnnamed(live, false);

      return setupReserveFile();
    },
    dropUnnamed: (live, options) => Promise.resolve(removeUnnamed(live, options.isDryRun)),
    resolveImpPaths,

    createImage,

    createImageFromImp: (digest, impId, steps) =>
      createImage(digest, async (dir) => {
        await steps.hold(() => cloneFile(resolveImpPaths(impId).disk, join(dir, 'rootfs.ext4')));
        await steps.write(dir);
      }),

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

    // The images and the backup tree first, since every imp's shared bytes
    // need them; then the imps, from where the last pass stopped. An imp
    // the pass did not finish is left out, and the cache keeps its last count.
    measureUsage: async (imps) => {
      const deadline = Date.now() + USAGE_DEADLINE_MS;
      const owned: OwnedFile[] = [];
      const ids = imps.map((imp) => imp.impId);
      const start = Math.max(0, ids.indexOf(usageState.resumeImpId ?? ''));
      const ordered = [...ids.slice(start), ...ids.slice(0, start)];

      const readAll = async (files: readonly OwnedPath[]) => {
        for (const file of files) {
          const read = await readOwnedExtents(readFileExtents, file.path, deadline);

          owned.push({ owner: file.owner, extents: read.extents });

          if (!read.isComplete) {
            return false;
          }
        }

        return true;
      };

      const finished: string[] = [];

      const isOthersRead = await readAll(listOtherFiles());

      for (const impId of isOthersRead ? ordered : []) {
        if (!(await readAll(listImpFiles(impId)))) {
          break;
        }

        finished.push(impId);
      }

      const isPartial = finished.length < ordered.length;

      usageState.resumeImpId = isPartial ? (ordered[finished.length] ?? null) : null;

      const totals = countOwnerBytes(owned);

      const report = new Map(
        finished.map((impId) => {
          const total = totals.get(`imp:${impId}`) ?? { exclusiveBytes: 0, sharedBytes: 0 };

          return [impId, { ...total, isUpperBound: false }];
        }),
      );

      return { imps: report, isPartial };
    },

    readUsage: () => {
      const stats = statfsSync(deps.dataDir);
      const available = stats.bavail * stats.bsize;

      // a loop-mounted XFS file can grow only as far as its host directory lets it
      const hostFree = readLoopHostFreeBytes(deps.dataDir) ?? available;

      return Promise.resolve({
        usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
        availableBytes: Math.min(available, hostFree),
      });
    },
  };
}

interface OwnedPath {
  readonly owner: string;
  readonly path: string;
}

// a file removed since the listing holds nothing
async function readOwnedExtents(
  readFileExtents: typeof readExtents,
  path: string,
  deadline: number,
) {
  try {
    return await readFileExtents(path, deadline);
  } catch (error) {
    if (existsSync(path)) {
      throw error;
    }

    return { extents: [], isComplete: true };
  }
}

function listFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function listEntries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

// drops each entry of `dir` that `keep` does not name
function removeUnlisted(dir: string, keep: ReadonlySet<string>): void {
  const names = existsSync(dir) ? readdirSync(dir) : [];

  for (const name of names.filter((entry) => !keep.has(entry))) {
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}
