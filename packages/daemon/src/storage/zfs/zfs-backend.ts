import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createKeyedMutex } from '../../imps/keyed-mutex';
import { printLog } from '../../process/print-log';
import { runCommand } from '../../process/run-command';
import { createStreamRunner } from '../../process/run-stream';
import type { StreamRunner } from '../../process/run-stream';
import { readErrorMessage } from '../../read-error-message';
import {
  BACKUP_TREE,
  buildBackupPaths,
  buildImagePaths,
  buildImpPaths,
  buildSnapshotPaths,
} from '../data-layout';
import { isHoldingFiles, readDirectoryOrphan } from '../orphan-files';
import { printSweep } from '../print-sweep';
import { CheckpointIdTakenError } from '../storage-backend';
import type {
  DiskSource,
  DroppedStorage,
  LiveStorage,
  MoveSource,
  OrphanStorage,
  ReceiveStep,
  ReceivedCheckpoint,
  SendStep,
  StorageBackend,
  SweepResult,
} from '../storage-backend';
import {
  buildReceiveArgv,
  buildSendArgv,
  createZfsCommands,
  parseZfsMounts,
  parseZfsRelease,
} from './zfs-commands';
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

// `@bk-<run>-<imp>`: a backup run's copy of a disk, gone once the run ends
const BACKUP_SNAPSHOT = /@bk-[^@]+$/;

// `@mv-<move>`: a move's copy of a stopped disk, gone once the move ends
const MOVE_SNAPSHOT = /@mv-[^@]+$/;

// tries at a checkpoint id no snapshot in the pool has
const ID_ATTEMPTS = 5;

// what removeLeftovers removes, in this order, and the orphans it keeps
interface LeftoverPlan {
  readonly snapshots: readonly ZfsEntry[];
  readonly disks: readonly ZfsEntry[];
  readonly images: readonly ZfsEntry[];
  readonly impDirs: readonly string[];
  readonly memDirs: readonly string[];
  readonly orphans: readonly ZfsEntry[];
  readonly orphanCheckpoints: readonly ZfsEntry[];
  readonly orphanDirs: readonly OrphanDir[];
}

// an `imps/<id>` or `mem/<id>` with files and no row, kept with no disk
interface OrphanDir {
  readonly kind: 'imp' | 'memory';
  readonly id: string;
  readonly dir: string;
}

interface ZfsBackendDeps {
  readonly dataDir: string;

  // the dataset mounted on dataDir, such as tank/imp
  readonly root: string;
  readonly run?: CommandRunner;

  // `zfs send` and `zfs recv` for moves
  readonly streams?: StreamRunner;

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
  const streams = deps.streams ?? createStreamRunner();

  // a move's snapshots while it sends: no GC drops them
  const heldSnapshots = new Set<string>();

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

  const setupMount = async (name: string, dir: string, isReadOnly = false): Promise<void> => {
    const mounted = parseZfsMounts(readMounts()).get(dir);

    if (mounted === name) {
      return;
    }

    if (mounted !== undefined) {
      throw new Error(`zfs: ${dir} has ${mounted} mounted, not ${name}`);
    }

    mkdirSync(dir, { recursive: true });

    await zfs.mount(name, dir, { isReadOnly });
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

    const next = planReclaimStep(entries, datasets);

    if (next === null) {
      return true;
    }

    await (next.kind === 'promote' ? zfs.promote(next.name) : zfs.destroy(next.name));

    log(`impd: zfs: reclaim: ${next.kind === 'promote' ? 'promoted' : 'destroyed'} ${next.name}`);

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

    if (source.kind === 'empty') {
      throw new Error('zfs: an empty disk has no origin');
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

    // every command impd runs exists in 2.2 and later
    // (docs/architecture/storage.md#versions), so a minor skew only warns
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

    // newest first: a move's clones go before their origins
    for (const staged of listChildren(entries, datasets.staging).toReversed()) {
      const impId = staged.name.slice(buildRestoreName('').length);

      if (staged.name.startsWith(buildRestoreName('')) && !names.has(buildDiskName(impId))) {
        await zfs.rename(staged.name, buildDiskName(impId));

        log(`impd: zfs: finished the restore of ${impId} that a crash cut short`);
        continue;
      }

      // a backup run's clones are mounted in the backup tree
      for (const [dir, name] of parseZfsMounts(readMounts())) {
        if (name === staged.name) {
          await zfs.unmount(dir);
        }
      }

      // a build cut short after its `@base`, before its rename, and a move's
      // received datasets carry snapshots
      await zfs.destroyRecursive(staged.name);

      log(`impd: zfs: destroyed ${staged.name}, a clone or build a crash cut short`);
      removeMountDir(buildStagingDir(staged.name));
    }
  };

  // What the database does not name: a crash leftover goes, an orphan stays
  // with its snapshots unless `isOrphans`. A lost database would make every
  // disk an orphan (docs/architecture/storage.md#what-a-sweep-takes).
  const planLeftovers = (
    entries: readonly ZfsEntry[],
    live: LiveStorage,
    isOrphans: boolean,
  ): LeftoverPlan => {
    const liveDigests = new Set([...live.imageDigests].map((digest) => toDigestHex(digest)));

    const unknownDisks = listChildren(entries, datasets.disks).filter(
      (disk) => !live.impIds.has(readChildId(disk.name, datasets.disks)),
    );

    const unknownImages = listChildren(entries, datasets.images).filter(
      (image) => !liveDigests.has(readChildId(image.name, datasets.images)),
    );

    // every image, too: one with no `@base` may be a build cut short, but
    // only a `staging/` name proves that, and start settles those
    const orphans = [...unknownDisks, ...unknownImages];

    const orphanNames = new Set(orphans.map((orphan) => orphan.name));

    const isLiveCheckpoint = (snapshot: ZfsEntry) =>
      CHECKPOINT_SNAPSHOT.test(snapshot.name) &&
      live.checkpointIds.has(readSnapshotId(snapshot.name));

    // An orphan's snapshots go only with it, before the retire, so the
    // reclaim can free it; its `@base` goes with the image.
    const isOnOrphan = (snapshot: ZfsEntry) => orphanNames.has(readSnapshotDataset(snapshot.name));

    // A checkpoint with no row is an orphan wherever it is, on a named disk or
    // in `retired/`: an older database lacks the newer rows. A fork, backup or
    // move snapshot elsewhere is impd's own, and never outlives its operation.
    const isOrphanCheckpoint = (snapshot: ZfsEntry) =>
      CHECKPOINT_SNAPSHOT.test(snapshot.name) && !isLiveCheckpoint(snapshot);

    const isDead = (snapshot: ZfsEntry) => {
      if (isOnOrphan(snapshot)) {
        return isOrphans && !snapshot.name.endsWith('@base') && !isLiveCheckpoint(snapshot);
      }

      return (
        FORK_SNAPSHOT.test(snapshot.name) ||
        BACKUP_SNAPSHOT.test(snapshot.name) ||
        (MOVE_SNAPSHOT.test(snapshot.name) && !heldSnapshots.has(snapshot.name)) ||
        (isOrphans && isOrphanCheckpoint(snapshot))
      );
    };

    const unmarked = entries.filter((entry) => entry.type === 'snapshot' && !entry.deferDestroy);
    const snapshots = unmarked.filter((entry) => isDead(entry));

    const orphanCheckpoints = isOrphans
      ? []
      : unmarked.filter((entry) => !isOnOrphan(entry) && isOrphanCheckpoint(entry));

    // A directory with no row goes with a kept disk. With no disk, only an
    // empty one is provably nothing; one with files is an orphan.
    const keptDisks = isOrphans ? [] : unknownDisks;

    const keptImpIds = new Set(keptDisks.map((disk) => readChildId(disk.name, datasets.disks)));

    const listUnknownDirs = (kind: OrphanDir['kind'], parent: string): OrphanDir[] =>
      (existsSync(parent) ? readdirSync(parent).toSorted() : [])
        .filter((id) => !live.impIds.has(id) && !keptImpIds.has(id))
        .map((id) => ({ kind, id, dir: join(parent, id) }));

    const unknownDirs = [
      ...listUnknownDirs('imp', join(deps.dataDir, 'imps')),
      ...listUnknownDirs('memory', join(deps.dataDir, 'mem')),
    ];

    const isDirDropped = (entry: OrphanDir) => isOrphans || !isHoldingFiles(entry.dir);
    const droppedDirs = unknownDirs.filter((entry) => isDirDropped(entry));

    return {
      snapshots,
      disks: isOrphans ? unknownDisks : [],
      images: isOrphans ? unknownImages : [],
      impDirs: droppedDirs.filter((entry) => entry.kind === 'imp').map((entry) => entry.id),
      memDirs: droppedDirs.filter((entry) => entry.kind === 'memory').map((entry) => entry.id),
      orphans: isOrphans ? [] : orphans,
      orphanCheckpoints,
      orphanDirs: unknownDirs.filter((entry) => !isDirDropped(entry)),
    };
  };

  const toDropped = (plan: LeftoverPlan): DroppedStorage[] => [
    ...plan.snapshots.map((snapshot) =>
      CHECKPOINT_SNAPSHOT.test(snapshot.name)
        ? { kind: 'checkpoint' as const, id: readSnapshotId(snapshot.name) }
        : { kind: 'snapshot' as const, id: snapshot.name },
    ),
    ...plan.images.map((image) => ({
      kind: 'image' as const,
      id: readChildId(image.name, datasets.images),
    })),
    ...[
      ...new Set([
        ...plan.disks.map((disk) => readChildId(disk.name, datasets.disks)),
        ...plan.impDirs,
      ]),
    ].map((impId) => ({ kind: 'imp' as const, id: impId })),
    ...plan.memDirs.map((impId) => ({ kind: 'memory' as const, id: impId })),
  ];

  // the size, age and snapshots of each orphan, for the log and `imp gc`
  const readOrphans = async (
    entries: readonly ZfsEntry[],
    plan: LeftoverPlan,
  ): Promise<OrphanStorage[]> => {
    const dirs = plan.orphanDirs.map((entry) =>
      readDirectoryOrphan(entry.kind, entry.id, entry.dir, []),
    );

    if (plan.orphans.length === 0 && plan.orphanCheckpoints.length === 0) {
      return dirs;
    }

    const listed = await zfs.listSpace(deps.root);

    const space = new Map(listed.map((entry) => [entry.name, entry]));

    const datasetOrphans = plan.orphans.map((orphan): OrphanStorage => {
      const isDisk = orphan.name.startsWith(`${datasets.disks}/`);
      const parent = isDisk ? datasets.disks : datasets.images;
      const found = space.get(orphan.name);

      return {
        kind: isDisk ? 'imp' : 'image',
        id: readChildId(orphan.name, parent),
        location: orphan.name,
        bytes: found?.used ?? 0,
        createdAt: found?.createdAt ?? null,
        snapshots: entries
          .filter((entry) => entry.type === 'snapshot' && entry.name.startsWith(`${orphan.name}@`))
          .map((snapshot) => readSnapshotId(snapshot.name)),
      };
    });

    const checkpoints = plan.orphanCheckpoints.map(
      (snapshot): OrphanStorage => ({
        kind: 'checkpoint',
        id: readSnapshotId(snapshot.name),
        location: snapshot.name,
        bytes: space.get(snapshot.name)?.used ?? 0,
        createdAt: space.get(snapshot.name)?.createdAt ?? null,
        snapshots: [],
      }),
    );

    return [...datasetOrphans, ...checkpoints, ...dirs];
  };

  // Drops what the database no longer names and a crash explains, and the
  // orphans with `isOrphans`. Snapshots go first: a retire renames the
  // dataset they are on. The caller runs it serially.
  const removeLeftovers = async (
    live: LiveStorage,
    options: Readonly<{ isDryRun: boolean; isOrphans: boolean }>,
  ): Promise<SweepResult> => {
    const entries = await listAll();

    const names = new Set(entries.map((entry) => entry.name));

    const plan = planLeftovers(entries, live, options.isOrphans);

    const kept = await readOrphans(entries, plan);

    if (options.isDryRun) {
      return { dropped: toDropped(plan), kept };
    }

    for (const snapshot of plan.snapshots) {
      await zfs.destroyDeferred(snapshot.name);
    }

    for (const disk of plan.disks) {
      await removeMount(buildDiskDir(readChildId(disk.name, datasets.disks)));
      await removeDataset(disk.name);
    }

    for (const image of plan.images) {
      await removeMount(buildImageDir(readChildId(image.name, datasets.images)));

      // a crash between the rename and the snapshot leaves an image without one
      if (names.has(`${image.name}@base`)) {
        await zfs.destroyDeferred(`${image.name}@base`);
      }

      await removeDataset(image.name);
    }

    // an imp's directory holds its disk's mount point: never one in use
    const mounted = [...parseZfsMounts(readMounts()).keys()];

    for (const impId of plan.impDirs) {
      const dir = buildImpPaths(deps.dataDir, impId).dir;

      if (!mounted.some((mount) => mount.startsWith(`${dir}/`))) {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    for (const impId of plan.memDirs) {
      rmSync(join(deps.dataDir, 'mem', impId), { recursive: true, force: true });
    }

    return { dropped: toDropped(plan), kept };
  };

  const setupMounts = async (): Promise<void> => {
    const entries = await listAll();

    for (const disk of listChildren(entries, datasets.disks)) {
      await setupMount(disk.name, buildDiskDir(readChildId(disk.name, datasets.disks)));
    }

    for (const image of listChildren(entries, datasets.images)) {
      await setupMount(image.name, buildImageDir(readChildId(image.name, datasets.images)));
    }
  };

  // Mounts a staged image dataset for `write`, then renames it into place
  // with its @base snapshot; a failed write destroys it.
  const createImageFromStaging = async (
    digest: string,
    staged: string,
    write: (dir: string) => Promise<void>,
  ): Promise<void> => {
    const dir = buildStagingDir(staged);

    try {
      await runSerial(() => setupMount(staged, dir));
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

      // the snapshot moves with the rename, so no image is ever without one
      await zfs.snapshot(`${staged}@base`);
      await zfs.rename(staged, name);

      await setupMount(name, buildImageDir(digest));
    });
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

  // Read-only clones of each snapshot, mounted in staging, for a move to an
  // XFS host: the last is the disk, the others the checkpoints in order
  const openMoveFiles = async (
    snapshots: readonly string[],
    removeMoveSnapshot: () => Promise<void>,
  ): Promise<MoveSource> => {
    const moveId = Bun.randomUUIDv7();
    const clones: { name: string; dir: string }[] = [];

    const removeClones = async () => {
      await runSerial(async () => {
        for (const clone of clones.splice(0).toReversed()) {
          await removeMount(clone.dir);

          await zfs.destroy(clone.name);

          removeMountDir(clone.dir);
        }
      });

      await removeMoveSnapshot();
    };

    try {
      await runSerial(async () => {
        for (const [index, snapshot] of snapshots.entries()) {
          const name = `${datasets.staging}/mv-${moveId}-${String(index)}`;
          const dir = buildStagingDir(name);

          await zfs.clone(snapshot, name, { readonly: 'on' });

          clones.push({ name, dir });

          await setupMount(name, dir, true);
        }
      });
    } catch (error) {
      await removeClones();

      throw error;
    }

    const paths = clones.map((clone) => join(clone.dir, ROOTFS_FILE));

    return {
      kind: 'files',
      checkpointPaths: paths.slice(0, -1),
      diskPath: paths.at(-1) ?? '',
      close: removeClones,
    };
  };

  // The snapshots in the order they were made, each incremental from the
  // last one before it on its dataset, a clone stream from its dataset's
  // origin, or else full (docs/architecture/moves.md#zfs-to-zfs)
  const planSendSteps = async (
    entries: readonly ZfsEntry[],
    wanted: ReadonlyMap<string, string | null>,
  ): Promise<SendStep[]> => {
    const origins = new Map(entries.map((entry) => [entry.name, entry.origin]));

    const ordered = entries.filter((entry) => wanted.has(entry.name)).map((entry) => entry.name);

    const stepOf = new Map<string, number>();
    const lastOn = new Map<string, number>();
    const datasetOf = new Map<string, number>();

    const steps: SendStep[] = [];

    for (const snapshot of ordered) {
      const dataset = snapshot.slice(0, snapshot.indexOf('@'));
      const origin = origins.get(dataset) ?? null;
      const earlier = lastOn.get(dataset);
      const fromOrigin = origin === null ? undefined : stepOf.get(origin);
      const base = earlier ?? fromOrigin ?? null;

      if (!datasetOf.has(dataset)) {
        datasetOf.set(dataset, datasetOf.size);
      }

      const baseName = base === null ? null : (ordered[base] ?? null);

      const estimateBytes = await zfs.estimateSend(snapshot, baseName);

      stepOf.set(snapshot, steps.length);
      lastOn.set(dataset, steps.length);

      steps.push({
        checkpointId: wanted.get(snapshot) ?? null,
        dataset: datasetOf.get(dataset) ?? 0,
        base,
        estimateBytes,
        open: () => streams.readFrom(buildSendArgv(snapshot, baseName)),
      });
    }

    return steps;
  };

  // a checkpoint id no snapshot in the pool has
  const pickCheckpointId = (
    entries: readonly ZfsEntry[],
    picked: readonly string[],
    buildId: () => string,
  ): string => {
    const tried = { id: '' };

    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
      tried.id = buildId();

      if (listCheckpointSnapshots(entries, tried.id).length === 0 && !picked.includes(tried.id)) {
        return tried.id;
      }
    }

    throw new CheckpointIdTakenError(tried.id);
  };

  // Each stream into staging, then the disk's into place and the others
  // retired, as a restore leaves them. What a failure leaves:
  // docs/architecture/moves.md#zfs-to-zfs
  const writeReceived = async (
    impId: string,
    steps: readonly ReceiveStep[],
    readStep: (index: number) => ReadableStream<Uint8Array>,
    buildId: () => string,
  ): Promise<ReceivedCheckpoint[]> => {
    checkReceiveSteps(steps);

    const buildStaged = (dataset: number) => `${datasets.staging}/mvin-${impId}-${String(dataset)}`;

    const entries = await runSerial(listAll);

    const names: string[] = [];

    for (const step of steps) {
      const name = step.isCheckpoint
        ? pickCheckpointId(entries, names, buildId)
        : `mv-${Bun.randomUUIDv7()}`;

      names.push(name);
    }

    try {
      for (const [index, step] of steps.entries()) {
        const dataset = buildStaged(step.dataset);
        const base = step.base === null ? undefined : steps[step.base];
        const isClone = base !== undefined && base.dataset !== step.dataset;

        const origin = isClone
          ? `${buildStaged(base.dataset)}@${names[step.base ?? 0] ?? ''}`
          : null;

        await streams.writeTo(
          buildReceiveArgv(`${dataset}@${names[index] ?? ''}`, origin),
          readStep(index),
        );
      }

      return await runSerial(() => setupReceived(impId, steps, names, buildStaged));
    } catch (error) {
      // by listing, so a stream that failed after `zfs recv` committed it
      // goes too; newest first by createtxg, so each clone before its origin
      await runSerial(async () => {
        const prefix = buildStaged(0).slice(0, -1);

        const listed = await listAll();

        const left = listed.filter(
          (entry) => entry.type !== 'snapshot' && entry.name.startsWith(prefix),
        );

        for (const dataset of left.toReversed()) {
          await zfs.destroyRecursive(dataset.name);
        }
      });

      throw error;
    }
  };

  const setupReceived = async (
    impId: string,
    steps: readonly ReceiveStep[],
    names: readonly string[],
    buildStaged: (dataset: number) => string,
  ): Promise<ReceivedCheckpoint[]> => {
    const last = steps.at(-1);

    const finalNames = new Map<number, string>();

    for (const step of steps) {
      if (!finalNames.has(step.dataset)) {
        const isDisk = step.dataset === last?.dataset;
        const name = isDisk ? buildDiskName(impId) : `${datasets.retired}/${Bun.randomUUIDv7()}`;

        await zfs.rename(buildStaged(step.dataset), name);

        finalNames.set(step.dataset, name);
      }
    }

    await setupMount(buildDiskName(impId), buildDiskDir(impId));

    const checkpoints: ReceivedCheckpoint[] = [];

    for (const [index, step] of steps.entries()) {
      const snapshot = `${finalNames.get(step.dataset) ?? ''}@${names[index] ?? ''}`;

      if (step.isCheckpoint) {
        checkpoints.push({ id: names[index] ?? '', sizeBytes: await zfs.readWritten(snapshot) });
      } else {
        // the disk's own snapshot served the stream only
        await zfs.destroyDeferred(snapshot);
      }
    }

    return checkpoints;
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

        const swept = await removeLeftovers(live, { isDryRun: false, isOrphans: false });

        printSweep(log, 'impd: storage', swept, 'each');

        await runReclaim(runReclaimStep);
        await setupMounts();
      }),

    dropUnnamed: async (live, options) => {
      const swept = await runSerial(() => removeLeftovers(live, options));

      if (!options.isDryRun) {
        startReclaim();
      }

      return swept;
    },

    resolveImpPaths,
    openMoveSource: async (impId, checkpointIds, mode) => {
      const disk = `${buildDiskName(impId)}@mv-${Bun.randomUUIDv7()}`;

      // the imp is stopped and marked: no write lands after this
      await runSnapshot(() => zfs.snapshot(disk));

      heldSnapshots.add(disk);

      const removeMoveSnapshot = async () => {
        heldSnapshots.delete(disk);

        await runSerial(() => zfs.destroyDeferred(disk));
      };

      try {
        const entries = await runSerial(listAll);

        const wanted = new Map<string, string | null>([
          ...checkpointIds.map((id): [string, string] => [findCheckpointSnapshot(entries, id), id]),
          [disk, null],
        ]);

        if (mode === 'files') {
          return await openMoveFiles([...wanted.keys()], removeMoveSnapshot);
        }

        const steps = await planSendSteps(entries, wanted);

        return { kind: 'zfs', steps, close: removeMoveSnapshot };
      } catch (error) {
        await removeMoveSnapshot();

        throw error;
      }
    },

    receiveMoveSnapshots: (impId, steps, readStep, buildId) =>
      writeReceived(impId, steps, readStep, buildId),

    createImage: async (digest, write) => {
      const staged = `${datasets.staging}/image-${Bun.randomUUIDv7()}`;

      await runSerial(() => zfs.create(staged));
      await createImageFromStaging(digest, staged, write);
    },

    // The fork of a live disk, as createImpDisk makes one, in staging: the
    // image's origin is the imp's disk until a reclaim promotes it.
    createImageFromImp: async (digest, impId, steps) => {
      const staged = `${datasets.staging}/image-${Bun.randomUUIDv7()}`;
      const snapshot = `${buildDiskName(impId)}@fork-${Bun.randomUUIDv7()}`;

      await steps.hold(() =>
        runSnapshot(async () => {
          await zfs.snapshot(snapshot);

          try {
            await zfs.clone(snapshot, staged);
          } finally {
            await zfs.destroyDeferred(snapshot);
          }
        }),
      );

      await createImageFromStaging(digest, staged, steps.write);
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

      if (source.kind === 'empty') {
        await runSerial(async () => {
          await zfs.create(target);

          await setupMount(target, buildDiskDir(impId));
        });

        writeFileSync(join(buildDiskDir(impId), ROOTFS_FILE), '');

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

    // the frozen guest waits for no reclaim, as with a checkpoint
    createBackupCopy: (impId, runId) =>
      runSnapshot(() => zfs.snapshot(`${buildDiskName(impId)}@bk-${runId}-${impId}`)),

    // Read-only clones in staging, mounted in the tree. Each disk copy is
    // marked at once, so ZFS drops it with its clone and a removed imp's
    // retired disk goes once the run closes.
    openBackupTree: async (request) => {
      const tree = buildBackupPaths(deps.dataDir).tree;
      const clones: { name: string; dir: string }[] = [];

      const impIds = new Set<string>();
      const checkpointIds = new Set<string>();
      const imageDigests = new Set<string>();

      const removeClones = async () => {
        await runSerial(async () => {
          for (const clone of clones.splice(0)) {
            await removeMount(clone.dir);

            await zfs.destroy(clone.name);
          }

          // a copy that never made it into the tree
          const entries = await listAll();

          for (const snapshot of entries) {
            const isLeft = snapshot.type === 'snapshot' && !snapshot.deferDestroy;

            if (isLeft && snapshot.name.includes(`@bk-${request.runId}-`)) {
              await zfs.destroyDeferred(snapshot.name);
            }
          }
        });

        startReclaim();
      };

      const createTreeClone = async (snapshot: string, name: string, relativeDir: string) => {
        const dir = join(tree, relativeDir);

        await zfs.clone(snapshot, name, { readonly: 'on' });

        clones.push({ name, dir });

        await setupMount(name, dir, true);
      };

      const createTreeClones = async () => {
        const mounted = [...parseZfsMounts(readMounts()).keys()].find((dir) =>
          dir.startsWith(`${tree}/`),
        );

        if (mounted !== undefined) {
          throw new Error(`zfs: ${mounted} in the backup tree is still mounted`);
        }

        // empty mount points of the last run
        rmSync(join(tree, 'imps'), { recursive: true, force: true });
        rmSync(join(tree, 'images'), { recursive: true, force: true });

        const entries = await listAll();

        for (const imp of request.imps) {
          const copy = entries.find(
            (entry) =>
              entry.type === 'snapshot' && entry.name.endsWith(`@bk-${request.runId}-${imp.impId}`),
          );

          if (copy === undefined) {
            continue;
          }

          const diskDir = dirname(BACKUP_TREE.buildDisk(imp.impId));

          await createTreeClone(copy.name, `${datasets.staging}/bk-${imp.impId}`, diskDir);

          await zfs.destroyDeferred(copy.name);

          impIds.add(imp.impId);

          for (const checkpointId of imp.checkpointIds) {
            const [snapshot, ...others] = listCheckpointSnapshots(entries, checkpointId);

            // deleted since the database copy
            if (snapshot === undefined || others.length > 0 || snapshot.deferDestroy) {
              continue;
            }

            const checkpointDir = dirname(BACKUP_TREE.buildCheckpointDisk(imp.impId, checkpointId));

            await createTreeClone(
              snapshot.name,
              `${datasets.staging}/bkc-${checkpointId}`,
              checkpointDir,
            );

            checkpointIds.add(checkpointId);
          }
        }

        for (const digest of request.imageDigests) {
          const base = entries.find((entry) => entry.name === `${buildImageName(digest)}@base`);

          if (base === undefined || base.deferDestroy) {
            continue;
          }

          const name = `${datasets.staging}/bki-${toDigestHex(digest)}`;

          await createTreeClone(base.name, name, BACKUP_TREE.buildImageDir(digest));

          imageDigests.add(digest);
        }
      };

      try {
        await runSerial(createTreeClones);
      } catch (error) {
        await removeClones().catch((closeError: unknown) => {
          log(`impd: zfs: could not close the backup tree: ${readErrorMessage(closeError)}`);
        });

        throw error;
      }

      return { impIds, checkpointIds, imageDigests, close: removeClones };
    },

    waitForReclaim: async () => {
      await reclaim.running;
    },

    stop: async () => {
      await reclaim.running;
    },

    measureUsage: async (imps) => {
      const space = await zfs.listSpace(deps.root);

      const byName = new Map(space.map((entry) => [entry.name, entry]));

      const report = new Map(
        imps.map((imp) => {
          const disk = buildDiskName(imp.impId);

          const checkpointIds = new Set(imp.checkpointIds);

          // after a restore, the imp's older checkpoints live on a retired
          // dataset; its whole `used` goes with them
          const retiredSnapshots = space.filter(
            (entry) =>
              entry.name.startsWith(`${datasets.retired}/`) &&
              CHECKPOINT_SNAPSHOT.test(entry.name) &&
              checkpointIds.has(readSnapshotId(entry.name)),
          );

          const retiredNames = new Set(
            retiredSnapshots.map((entry) => entry.name.split('@')[0] ?? ''),
          );

          const snapshots = [
            ...space.filter((entry) => entry.name.startsWith(`${disk}@`)),
            ...retiredSnapshots,
          ];

          const found = byName.get(disk);

          const usage = {
            exclusiveBytes:
              (found?.used ?? 0) +
              [...retiredNames].reduce((sum, name) => sum + (byName.get(name)?.used ?? 0), 0) +
              readAllocatedBytes(resolveImpPaths(imp.impId).memFile),

            // what it refers to from its origin: the image or a checkpoint
            sharedBytes: Math.max(0, (found?.referenced ?? 0) - (found?.usedByDataset ?? 0)),

            // a fork holds blocks a destroy would otherwise free; the imp's
            // own disk, cloned from a retired checkpoint, is not a fork
            isUpperBound: snapshots.some((entry) => entry.clones.some((clone) => clone !== disk)),
          };

          return [imp.impId, usage];
        }),
      );

      return { imps: report, isPartial: false };
    },

    readUsage: async () => {
      const usage = await zfs.readUsage(deps.root);

      return { usedBytes: usage.used, availableBytes: usage.available };
    },
  };
}

function readAllocatedBytes(path: string): number {
  return existsSync(path) ? statSync(path).blocks * 512 : 0;
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

function readSnapshotDataset(name: string): string {
  return name.slice(0, name.indexOf('@'));
}

// `tank/imp/disks/<id>` → `<id>`
function readChildId(name: string, parent: string): string {
  return name.slice(parent.length + 1);
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

// A peer's plan: each base comes before its step, a dataset's first step is
// full or a clone, every later one incremental from the step before it on
// that dataset, and only the last step is the disk's own
function checkReceiveSteps(steps: readonly ReceiveStep[]): void {
  const lastOn = new Map<number, number>();

  for (const [index, step] of steps.entries()) {
    const base = step.base === null ? undefined : steps[step.base];
    const earlier = lastOn.get(step.dataset);
    const isInOrder = step.base === null || step.base < index;

    const isChained =
      earlier === undefined ? base?.dataset !== step.dataset : step.base === earlier;

    const isLast = index === steps.length - 1;

    if (!isInOrder || !isChained || step.isCheckpoint === isLast) {
      throw new Error(`zfs: step ${String(index)} of the move does not follow on`);
    }

    lastOn.set(step.dataset, index);
  }

  if (steps.length === 0) {
    throw new Error('zfs: a move with no steps');
  }
}
