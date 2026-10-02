import type { StreamedCommand } from '../process/run-stream';
import type { ImpPaths } from './data-layout';

export type StorageBackendKind = 'xfs' | 'zfs';

// Where a new imp disk comes from. An imp source is its live disk: the caller
// freezes the guest around the call. An empty disk is a zero-length file for
// a backup restore to write into.
export type DiskSource =
  | { readonly kind: 'image'; readonly digest: string }
  | { readonly kind: 'imp'; readonly impId: string }
  | { readonly kind: 'checkpoint'; readonly impId: string; readonly checkpointId: string }
  | { readonly kind: 'empty' };

// `isReusable` lets XFS keep last run's copy when the disk is unchanged
interface BackupCopyOptions {
  readonly isReusable: boolean;
}

// What one backup run reads, as its database copy names it.
interface BackupTreeRequest {
  readonly runId: string;

  // the imps createBackupCopy copied this run
  readonly imps: readonly { readonly impId: string; readonly checkpointIds: readonly string[] }[];
  readonly imageDigests: readonly string[];
}

// The backup tree at BACKUP_TREE's paths, until close. It holds what was asked
// for less anything removed since the database copy.
export interface BackupTree {
  readonly impIds: ReadonlySet<string>;
  readonly checkpointIds: ReadonlySet<string>;
  readonly imageDigests: ReadonlySet<string>;
  readonly close: () => Promise<void>;
}

interface StorageUsage {
  readonly usedBytes: number;
  readonly availableBytes: number;
}

// Exclusive is what removing the imp frees; shared, what it holds with an
// image, another imp or the backup tree. docs/architecture/storage.md has more.
export interface ImpDiskUsage {
  readonly exclusiveBytes: number;
  readonly sharedBytes: number;
  readonly isUpperBound: boolean;
}

export interface DiskUsageReport {
  readonly imps: ReadonlyMap<string, ImpDiskUsage>;

  // a pass cut short at its time limit counts only the files it read
  readonly isPartial: boolean;
}

// What the database holds when impd starts. A backend drops what else it
// finds only when a crash explains it; the rest is an orphan, and stays
// (docs/architecture/storage.md#cleanup).
export interface LiveStorage {
  readonly impIds: ReadonlySet<string>;
  readonly checkpointIds: ReadonlySet<string>;
  readonly imageDigests: ReadonlySet<string>;
}

// What dropUnnamed removed, or would remove in a dry run. `snapshot` is a
// ZFS fork or backup snapshot, named in full; `memory` an imp's memory
// snapshot outside its imp directory.
export interface DroppedStorage {
  readonly kind: 'imp' | 'checkpoint' | 'image' | 'snapshot' | 'memory';
  readonly id: string;
}

// What no row names and no crash provably explains: an imp's disk or
// directory, a memory snapshot (ZFS), a checkpoint or an image, as a lost
// database leaves them. A sweep keeps it unless asked for orphans.
export interface OrphanStorage {
  readonly kind: 'imp' | 'image' | 'memory' | 'checkpoint';
  readonly id: string;

  // the dataset or snapshot, or the directory on XFS
  readonly location: string;

  // snapshots and checkpoints included
  readonly bytes: number;
  readonly createdAt: Date | null;

  // the names after `@`, or the checkpoint ids on XFS
  readonly snapshots: readonly string[];
}

interface SweepOptions {
  readonly isDryRun: boolean;

  // retire the orphans too: `imp gc --orphans`
  readonly isOrphans: boolean;
}

export interface SweepResult {
  readonly dropped: readonly DroppedStorage[];

  // the orphans the sweep kept; none when it took them
  readonly kept: readonly OrphanStorage[];
}

// How a move carries the disk: as files, or as ZFS send streams between two
// ZFS hosts
export type MoveMode = 'files' | 'zfs';

// One snapshot of a ZFS move, in the order the streams go
export interface SendStep {
  // the snapshot's own name, after the `@`
  readonly snapshot: string;

  // null for the disk's own snapshot, which goes last
  readonly checkpointId: string | null;

  // which of the imp's datasets holds it, from 0
  readonly dataset: number;

  // the earlier step this one is incremental from; on another dataset, the
  // dataset is a clone of it
  readonly base: number | null;
  readonly estimateBytes: number;
  readonly open: () => StreamedCommand;
}

export type MoveSource =
  | {
      readonly kind: 'files';
      readonly checkpointPaths: readonly string[];
      readonly diskPath: string;
      readonly close: () => Promise<void>;
    }
  | {
      readonly kind: 'zfs';
      readonly steps: readonly SendStep[];
      readonly close: () => Promise<void>;
    };

// A step as the target receives it, with the source's dataset numbers and
// bases; the target names each snapshot itself
export interface ReceiveStep {
  readonly isCheckpoint: boolean;
  readonly dataset: number;
  readonly base: number | null;
}

export interface ReceivedCheckpoint {
  readonly id: string;
  readonly sizeBytes: number;
}

// The disks, checkpoints and image rootfs files of imps (docs/architecture/storage.md). XFS
// clones files with reflink; ZFS keeps each disk in a dataset, a checkpoint as a snapshot and
// a fork as a clone.
export interface StorageBackend {
  readonly kind: StorageBackendKind;

  // before any VM is re-adopted or woken: mounts, finishes or undoes a restore
  // a crash cut short, and runs a sweep, which it logs
  readonly start: (live: LiveStorage) => Promise<void>;

  // Removes what `live` does not name and a crash explains, and the orphans
  // with `isOrphans`. The caller holds the storage gate alone, so nothing is
  // in flight (docs/architecture/storage.md#cleanup).
  readonly dropUnnamed: (live: LiveStorage, options: SweepOptions) => Promise<SweepResult>;

  // the data layout, with the disk and the memory snapshot where this
  // backend keeps them
  readonly resolveImpPaths: (impId: string) => ImpPaths;

  // What a move sends of a stopped, marked imp, until close: `checkpointIds`
  // oldest first. `zfs` needs a ZFS backend (docs/architecture/moves.md).
  readonly openMoveSource: (
    impId: string,
    checkpointIds: readonly string[],
    mode: MoveMode,
  ) => Promise<MoveSource>;

  // ZFS only: receives a ZFS move's streams as the new imp's disk and its
  // checkpoints. `readStep` gives each step's stream, in order; `buildId`, a
  // checkpoint id to try. Returns the checkpoints, in step order.
  readonly receiveMoveSnapshots: (
    impId: string,
    steps: readonly ReceiveStep[],
    readStep: (index: number) => ReadableStream<Uint8Array>,
    buildId: () => string,
  ) => Promise<ReceivedCheckpoint[]>;

  // `write` puts rootfs.ext4 and config.json in the directory it gets; the
  // backend then makes it the image's directory
  readonly createImage: (digest: string, write: (dir: string) => Promise<void>) => Promise<void>;

  // A template's image (docs/guides/templates.md): a clone of the imp's disk
  // is its rootfs.ext4. `hold` runs the clone with the disk consistent, and
  // `write` then puts config.json in the image's directory.
  readonly createImageFromImp: (
    digest: string,
    impId: string,
    steps: Readonly<{
      hold: (clone: () => Promise<void>) => Promise<void>;
      write: (dir: string) => Promise<void>;
    }>,
  ) => Promise<void>;
  readonly removeImage: (digest: string) => Promise<void>;

  readonly createImpDisk: (impId: string, source: DiskSource) => Promise<void>;

  // the imp's checkpoints go with it; their rows are gone already
  readonly removeImpDisk: (impId: string, checkpointIds: readonly string[]) => Promise<void>;

  // returns the checkpoint's size in bytes
  readonly createCheckpoint: (impId: string, checkpointId: string) => Promise<number>;
  readonly removeCheckpoint: (impId: string, checkpointId: string) => Promise<void>;

  // Prepares the checkpoint's disk, calls `halt`, then swaps the disk in. A
  // failure before the swap leaves the imp's disk as it was.
  readonly restoreCheckpoint: <T>(
    impId: string,
    checkpointId: string,
    halt: () => Promise<T>,
  ) => Promise<T>;

  // A crash-consistent copy of the imp's disk for the backup tree. The caller
  // holds the imp's lock and freezes a running guest only around this call.
  readonly createBackupCopy: (
    impId: string,
    runId: string,
    options: BackupCopyOptions,
  ) => Promise<void>;

  // Lays out the backup tree under buildBackupPaths(dataDir).tree, with no imp
  // locked: removeImpDisk and removeCheckpoint still work while restic reads.
  readonly openBackupTree: (request: BackupTreeRequest) => Promise<BackupTree>;

  readonly readUsage: () => Promise<StorageUsage>;

  // each imp's usage; slow on XFS, so a cache calls it now and then
  readonly measureUsage: (
    imps: readonly { readonly impId: string; readonly checkpointIds: readonly string[] }[],
  ) => Promise<DiskUsageReport>;

  // waits for background work (a ZFS reclaim) to finish, before impd exits
  readonly stop: () => Promise<void>;
}

// The id is in use already: on ZFS, a deleted checkpoint's snapshot stays
// while a fork needs it. The caller picks another id.
export class CheckpointIdTakenError extends Error {
  override name = 'CheckpointIdTakenError';

  constructor(checkpointId: string) {
    super(`a snapshot named ${checkpointId} exists already`);
  }
}
