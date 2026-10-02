import { existsSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { createKeyedMutex } from '../../imps/keyed-mutex';
import { printLog } from '../../process/print-log';
import { runCommand } from '../../process/run-command';
import { readErrorMessage } from '../../read-error-message';
import { buildImagePaths, buildImpPaths, buildSnapshotPaths } from '../data-layout';
import { CheckpointIdTakenError } from '../storage-backend';
import type { DiskSource, LiveStorage, StorageBackend } from '../storage-backend';
import { createZfsCommands, parseZfsMounts, parseZfsRelease } from './zfs-commands';
import type { CommandRunner, ZfsEntry } from './zfs-commands';
import { planReclaimStep } from './zfs-reclaim';

// ARC and record sizes are set where the datasets are made (deploy/
// bootstrap.sh); these are the defaults impd uses for what it creates itself.
const BLOCK_RECORDSIZE = '16K';

// held back, so a destroy still has room to run on a full pool: free it with
// `zfs set refreservation=none <root>/reserve`
const RESERVE_SIZE = '1G';

// the file in each disk and image dataset; a disk is a clone of an image
const ROOTFS_FILE = 'rootfs.ext4';

// a reclaim pass ends after this many steps, so a bug never spins
const MAX_RECLAIM_STEPS = 1000;
const CHECKPOINT_SNAPSHOT = /@cp-[^@]+$/;
const FORK_SNAPSHOT = /@fork-[^@]+$/;

interface ZfsBackendDeps {
  readonly dataDir: string;

  // the dataset mounted on dataDir, such as tank/imp
  readonly root: string;
  readonly run?: CommandRunner;

  // /proc/self/mounts and /sys/module/zfs/version by default
  readonly readMounts?: () => string;
  readonly readModuleVersion?: () => string | null;
  readonly log?: (message: string) => void;
}

// Each imp disk is a dataset holding one file, a checkpoint is a snapshot of
// it and a fork is a clone (docs/architecture/storage.md#zfs).
export interface ZfsBackend extends StorageBackend {
  // resolves once the reclaim that changes start in the background is done
  readonly waitForReclaim: () => Promise<void>;
}

export function createZfsBackend(deps: ZfsBackendDeps): ZfsBackend {
  const zfs = createZfsCommands(deps.run ?? runCommand);
  const log = deps.log ?? printLog;
  const readMounts = deps.readMounts ?? (() => readFileSync('/proc/self/mounts', 'utf8'));
  const readModuleVersion = deps.readModuleVersion ?? readZfsModuleVersion;

  // Dataset changes run one at a time: a reclaim must never see a restore
  // half done. Snapshots of a frozen guest have a lane of their own and never
  // wait for one; they touch no dataset a reclaim or restore moves.
  const mutex = createKeyedMutex();
  const runSerial = <T>(task: () => Promise<T>) => mutex.runExclusive('zfs', task);
  const runSnapshot = <T>(task: () => Promise<T>) => mutex.runExclusive('snapshot', task);
  const reclaim = { running: null as Promise<void> | null, isWanted: false };

  const datasets = {
    mem: `${deps.root}/mem`,
    disks: `${deps.root}/disks`,
    images: `${deps.root}/images`,
    retired: `${deps.root}/retired`,
    staging: `${deps.root}/staging`,
    reserve: `${deps.root}/reserve`,
  };

  const buildDiskName = (impId: string) => `${datasets.disks}/${impId}`;
  const buildImageName = (digest: string) => `${datasets.images}/${toDigestHex(digest)}`;
  const buildRestoreName = (impId: string) => `${datasets.staging}/restore-${impId}`;
  const buildDiskDir = (impId: string) => join(buildImpPaths(deps.dataDir, impId).dir, 'disk');
  const buildImageDir = (digest: string) => buildImagePaths(deps.dataDir, digest).dir;

  const buildStagingDir = (name: string) =>
    join(deps.dataDir, 'staging', name.slice(datasets.staging.length + 1));

  const resolveImpPaths = (impId: string) => ({
    ...buildImpPaths(deps.dataDir, impId),
    disk: join(buildDiskDir(impId), ROOTFS_FILE),
    ...buildSnapshotPaths(join(deps.dataDir, 'mem', impId)),
  });

  const listAll = () => zfs.list(deps.root);

  const setupMount = async (name: string, dir: string): Promise<void> => {
    const mounted = parseZfsMounts(readMounts()).get(dir);

    if (mounted === name) {
      return;
    }

    if (mounted !== undefined) {
      throw new Error(`zfs: ${dir} has ${mounted} mounted, not ${name}`);
    }

    mkdirSync(dir, { recursive: true });

    await zfs.mount(name, dir);
  };

  const removeMount = async (dir: string): Promise<void> => {
    if (parseZfsMounts(readMounts()).has(dir)) {
      await zfs.unmount(dir);
    }
  };

  // an old disk or image leaves the namespace at once; runReclaim frees it once
  // no checkpoint or clone needs its blocks
  const removeDataset = async (name: string): Promise<void> => {
    const retired = `${datasets.retired}/${Bun.randomUUIDv7()}`;

    await zfs.rename(name, retired);

    log(`impd: zfs: retired ${name} as ${retired}`);
  };

  // one promote or destroy; true when nothing is left to reclaim
  const runReclaimStep = async (): Promise<boolean> => {
    const entries = await listAll();

    const next = planReclaimStep(entries, datasets.retired);

    if (next === null) {
      return true;
    }

    await (next.kind === 'promote' ? zfs.promote(next.name) : zfs.destroy(next.name));

    return false;
  };

  // `runStep` queues each step on its own, so other changes go between them
  const runReclaim = async (runStep: () => Promise<boolean>): Promise<void> => {
    try {
      for (let step = 0; step < MAX_RECLAIM_STEPS; step += 1) {
        const isDone = await runStep();

        if (isDone) {
          return;
        }
      }

      log(`impd: zfs: reclaim stopped after ${String(MAX_RECLAIM_STEPS)} steps`);
    } catch (error) {
      // the space comes back on the next pass; the change itself is done
      log(`impd: zfs: reclaim failed: ${readErrorMessage(error)}`);
    }
  };

  // after a change that may free a retired dataset; never awaited by it
  const startReclaim = (): void => {
    reclaim.isWanted = true;

    if (reclaim.running !== null) {
      return;
    }

    const runPasses = async () => {
      while (reclaim.isWanted) {
        reclaim.isWanted = false;

        await runReclaim(() => runSerial(runReclaimStep));
      }

      reclaim.running = null;
    };

    reclaim.running = runPasses();
  };

  const findOrigin = async (source: DiskSource): Promise<string> => {
    if (source.kind === 'image') {
      return `${buildImageName(source.digest)}@base`;
    }

    if (source.kind === 'imp') {
      throw new Error('zfs: a fork of a live disk takes its own snapshot');
    }

    const entries = await listAll();

    return findCheckpointSnapshot(entries, source.checkpointId);
  };

  const checkVersions = async (): Promise<void> => {
    const kernel = readModuleVersion();

    if (kernel === null) {
      throw new Error('zfs: the kernel module is not loaded (no /sys/module/zfs/version)');
    }

    const userland = await zfs.readVersion();

    const userRelease = parseZfsRelease(userland);
    const kernelRelease = parseZfsRelease(kernel);

    if (userRelease.major !== kernelRelease.major) {
      throw new Error(
        `zfs: the userland is ${userland} but the kernel module is ${kernel}; they must match in major version`,
      );
    }

    // every command impd runs exists in 2.2 and later (docs/architecture/
    // storage.md#versions), so a minor skew only warns
    if (userRelease.minor !== kernelRelease.minor) {
      log(`impd: zfs: warning: the userland is ${userland} but the kernel module is ${kernel}`);
    }
  };

  const createMissingDatasets = async (): Promise<void> => {
    const entries = await listAll();

    const existing = new Set(entries.map((entry) => entry.name));

    const blocks = { recordsize: BLOCK_RECORDSIZE };

    const wanted: [string, Record<string, string>][] = [
      [datasets.mem, {}],
      [datasets.disks, blocks],
      [datasets.images, blocks],
      [datasets.staging, blocks],
      [datasets.retired, {}],
      [datasets.reserve, { refreservation: RESERVE_SIZE }],
    ];

    for (const [name, properties] of wanted) {
      if (!existing.has(name)) {
        await zfs.create(name, properties);
      }
    }
  };

  // A restore clones the checkpoint into staging, then renames it over the
  // disk. With the disk gone, the crash came between the two renames.
  const resolveStaging = async (): Promise<void> => {
    const entries = await listAll();

    const names = new Set(entries.map((entry) => entry.name));

    for (const staged of listChildren(entries, datasets.staging)) {
      const impId = staged.name.slice(buildRestoreName('').length);

      if (staged.name.startsWith(buildRestoreName('')) && !names.has(buildDiskName(impId))) {
        await zfs.rename(staged.name, buildDiskName(impId));

        log(`impd: zfs: finished the restore of ${impId} that a crash cut short`);
        continue;
      }

      await removeMount(buildStagingDir(staged.name));

      await zfs.destroy(staged.name);

      removeMountDir(buildStagingDir(staged.name));
    }
  };

  // Drops what the database no longer names. Snapshots go first: a retire
  // renames the dataset they are on.
  const removeLeftovers = async (live: LiveStorage): Promise<void> => {
    const entries = await listAll();

    const names = new Set(entries.map((entry) => entry.name));
    const liveDigests = new Set([...live.imageDigests].map((digest) => toDigestHex(digest)));

    const isDead = (snapshot: ZfsEntry) =>
      FORK_SNAPSHOT.test(snapshot.name) ||
      (CHECKPOINT_SNAPSHOT.test(snapshot.name) &&
        !live.checkpointIds.has(readSnapshotId(snapshot.name)));

    for (const snapshot of entries) {
      if (snapshot.type === 'snapshot' && !snapshot.deferDestroy && isDead(snapshot)) {
        await zfs.destroyDeferred(snapshot.name);
      }
    }

    for (const disk of listChildren(entries, datasets.disks)) {
      const impId = disk.name.slice(datasets.disks.length + 1);

      if (!live.impIds.has(impId)) {
        await removeMount(buildDiskDir(impId));
        await removeDataset(disk.name);
      }
    }

    for (const image of listChildren(entries, datasets.images)) {
      const digest = image.name.slice(datasets.images.length + 1);

      if (!liveDigests.has(digest)) {
        await removeMount(buildImageDir(digest));

        // a crash between the rename and the snapshot leaves an image without one
        if (names.has(`${image.name}@base`)) {
          await zfs.destroyDeferred(`${image.name}@base`);
        }

        await removeDataset(image.name);
      }
    }
  };

  const setupMounts = async (): Promise<void> => {
    const entries = await listAll();

    for (const disk of listChildren(entries, datasets.disks)) {
      await setupMount(disk.name, buildDiskDir(disk.name.slice(datasets.disks.length + 1)));
    }

    for (const image of listChildren(entries, datasets.images)) {
      await setupMount(image.name, buildImageDir(image.name.slice(datasets.images.length + 1)));
    }
  };

  // A swap that failed halfway leaves the imp a disk: the old one when it is
  // still in place, else the staged clone, as the next start would.
  const resolveFailedSwap = async (impId: string): Promise<void> => {
    try {
      const entries = await listAll();

      const names = new Set(entries.map((entry) => entry.name));

      if (!names.has(buildDiskName(impId))) {
        await zfs.rename(buildRestoreName(impId), buildDiskName(impId));
      } else if (names.has(buildRestoreName(impId))) {
        await zfs.destroy(buildRestoreName(impId));
      }

      await setupMount(buildDiskName(impId), buildDiskDir(impId));
    } catch (error) {
      log(
        `impd: zfs: ${impId}: the disk swap failed and so did its repair: ${readErrorMessage(error)}`,
      );
    }
  };

  return {
    kind: 'zfs',

    start: (live) =>
      runSerial(async () => {
        await checkVersions();

        if (parseZfsMounts(readMounts()).get(deps.dataDir) !== deps.root) {
          throw new Error(
            `zfs: ${deps.root} is not mounted on ${deps.dataDir} (host/scripts/setup-storage.sh mounts it)`,
          );
        }

        await createMissingDatasets();
        await setupMount(datasets.mem, join(deps.dataDir, 'mem'));
        await resolveStaging();
        await removeLeftovers(live);
        await runReclaim(runReclaimStep);
        await setupMounts();
      }),

    resolveImpPaths,

    createImage: async (digest, write) => {
      const staged = `${datasets.staging}/image-${Bun.randomUUIDv7()}`;
      const dir = buildStagingDir(staged);

      await runSerial(async () => {
        await zfs.create(staged);

        await setupMount(staged, dir);
      });

      try {
        await write(dir);
      } catch (error) {
        await runSerial(async () => {
          await removeMount(dir);

          await zfs.destroy(staged);
        });

        removeMountDir(dir);
        throw error;
      }

      await runSerial(async () => {
        const name = buildImageName(digest);

        await removeMount(dir);

        removeMountDir(dir);

        await zfs.rename(staged, name);
        await zfs.snapshot(`${name}@base`);

        await setupMount(name, buildImageDir(digest));
      });
    },

    removeImage: async (digest) => {
      await runSerial(async () => {
        const name = buildImageName(digest);

        const entries = await listAll();

        if (!entries.some((entry) => entry.name === name)) {
          return;
        }

        await removeMount(buildImageDir(digest));

        removeMountDir(buildImageDir(digest));

        if (entries.some((entry) => entry.name === `${name}@base`)) {
          await zfs.destroyDeferred(`${name}@base`);
        }

        await removeDataset(name);
      });

      startReclaim();
    },

    createImpDisk: async (impId, source) => {
      const target = buildDiskName(impId);

      // The caller has a live source frozen, so its fork takes the snapshot
      // lane and never waits for a reclaim. Its new clone is not retired, and
      // nothing else names it yet.
      if (source.kind === 'imp') {
        const snapshot = `${buildDiskName(source.impId)}@fork-${Bun.randomUUIDv7()}`;

        await runSnapshot(async () => {
          await zfs.snapshot(snapshot);

          try {
            await zfs.clone(snapshot, target);
          } finally {
            // ZFS keeps a fork snapshot while the clone needs it
            await zfs.destroyDeferred(snapshot);
          }

          await setupMount(target, buildDiskDir(impId));
        });

        return;
      }

      // a promote can move a checkpoint's snapshot, so the lookup is serial
      await runSerial(async () => {
        const origin = await findOrigin(source);

        await zfs.clone(origin, target);

        await setupMount(target, buildDiskDir(impId));
      });
    },

    removeImpDisk: async (impId, checkpointIds) => {
      await runSerial(async () => {
        const entries = await listAll();

        const names = new Set(entries.map((entry) => entry.name));

        for (const checkpointId of checkpointIds) {
          for (const snapshot of listCheckpointSnapshots(entries, checkpointId)) {
            if (!snapshot.deferDestroy) {
              await zfs.destroyDeferred(snapshot.name);
            }
          }
        }

        await removeMount(buildDiskDir(impId));

        if (names.has(buildRestoreName(impId))) {
          await zfs.destroy(buildRestoreName(impId));
        }

        if (names.has(buildDiskName(impId))) {
          await removeDataset(buildDiskName(impId));
        }
      });

      startReclaim();
    },

    createCheckpoint: (impId, checkpointId) =>
      runSnapshot(async () => {
        const entries = await listAll();

        // a deleted checkpoint's snapshot stays while a fork needs it
        if (listCheckpointSnapshots(entries, checkpointId).length > 0) {
          throw new CheckpointIdTakenError(checkpointId);
        }

        const snapshot = `${buildDiskName(impId)}@${checkpointId}`;

        await zfs.snapshot(snapshot);

        try {
          return await zfs.readWritten(snapshot);
        } catch (error) {
          await zfs.destroy(snapshot);

          throw error;
        }
      }),

    removeCheckpoint: async (_impId, checkpointId) => {
      await runSerial(async () => {
        const entries = await listAll();

        const snapshots = listCheckpointSnapshots(entries, checkpointId);

        if (snapshots.length > 1) {
          throw new Error(`zfs: ${String(snapshots.length)} snapshots are named ${checkpointId}`);
        }

        const [snapshot] = snapshots;

        if (snapshot !== undefined && !snapshot.deferDestroy) {
          await zfs.destroyDeferred(snapshot.name);
        }
      });

      startReclaim();
    },

    restoreCheckpoint: async (impId, checkpointId, halt) => {
      const staged = buildRestoreName(impId);

      await runSerial(async () => {
        const entries = await listAll();

        const snapshot = findCheckpointSnapshot(entries, checkpointId);

        if (entries.some((entry) => entry.name === staged)) {
          await zfs.destroy(staged);
        }

        await zfs.clone(snapshot, staged);
      });

      const halted = await halt().catch(async (error: unknown) => {
        try {
          await runSerial(() => zfs.destroy(staged));
        } catch (destroyError) {
          // the next start destroys it: the disk is still in place
          log(`impd: zfs: could not drop ${staged}: ${readErrorMessage(destroyError)}`);
        }

        throw error;
      });

      await runSerial(async () => {
        await removeMount(buildDiskDir(impId));

        try {
          await removeDataset(buildDiskName(impId));

          await zfs.rename(staged, buildDiskName(impId));
        } catch (error) {
          await resolveFailedSwap(impId);

          throw error;
        }

        await setupMount(buildDiskName(impId), buildDiskDir(impId));
      });

      startReclaim();

      return halted;
    },

    waitForReclaim: async () => {
      await reclaim.running;
    },

    readUsage: async () => {
      const usage = await zfs.readUsage(deps.root);

      return { usedBytes: usage.used, availableBytes: usage.available };
    },
  };
}

function readZfsModuleVersion(): string | null {
  try {
    return readFileSync('/sys/module/zfs/version', 'utf8').trim();
  } catch {
    return null;
  }
}

// Not recursive: a dataset still mounted there would lose its files.
function removeMountDir(dir: string): void {
  if (existsSync(dir)) {
    rmdirSync(dir);
  }
}

function toDigestHex(digest: string): string {
  return digest.replace(/^sha256:/, '');
}

function readSnapshotId(name: string): string {
  return name.slice(name.indexOf('@') + 1);
}

// the direct child filesystems of `parent`
function listChildren(entries: readonly ZfsEntry[], parent: string): ZfsEntry[] {
  return entries.filter(
    (entry) =>
      entry.type === 'filesystem' &&
      entry.name.startsWith(`${parent}/`) &&
      !entry.name.slice(parent.length + 1).includes('/'),
  );
}

// Checkpoint ids are global, so the snapshot is found by name wherever it is:
// a restore or a promote moves it to another dataset.
function listCheckpointSnapshots(entries: readonly ZfsEntry[], checkpointId: string): ZfsEntry[] {
  return entries.filter(
    (entry) => entry.type === 'snapshot' && readSnapshotId(entry.name) === checkpointId,
  );
}

function findCheckpointSnapshot(entries: readonly ZfsEntry[], checkpointId: string): string {
  const snapshots = listCheckpointSnapshots(entries, checkpointId);
  const [snapshot] = snapshots;

  if (snapshots.length !== 1 || snapshot === undefined) {
    throw new Error(
      `zfs: expected one snapshot named ${checkpointId}, found ${String(snapshots.length)}`,
    );
  }

  return snapshot.name;
}
