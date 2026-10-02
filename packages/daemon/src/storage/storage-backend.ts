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

// What the database holds when impd starts. Anything else a backend finds is
// left over from a crash, and start drops it.
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

// The disks, checkpoints and image rootfs files of imps (docs/architecture/
// storage.md). XFS clones files with reflink; ZFS keeps each disk in a
// dataset, a checkpoint as a snapshot and a fork as a clone.
export interface StorageBackend {
  readonly kind: StorageBackendKind;

  // before any VM is re-adopted or woken: mounts, finishes or undoes a restore
  // a crash cut short, and drops what `live` does not name
  readonly start: (live: LiveStorage) => Promise<void>;

  // Removes what `live` does not name; staging, retired datasets and backup
  // directories stay. The caller holds the storage gate alone, so nothing is
  // in flight (docs/architecture/storage.md#cleanup).
  readonly dropUnnamed: (
    live: LiveStorage,
    options: Readonly<{ isDryRun: boolean }>,
  ) => Promise<DroppedStorage[]>;

  // the data layout, with the disk and the memory snapshot where this
  // backend keeps them
  readonly resolveImpPaths: (impId: string) => ImpPaths;

  // `write` puts rootfs.ext4 and config.json in the directory it gets; the
  // backend then makes it the image's directory
  readonly createImage: (digest: string, write: (dir: string) => Promise<void>) => Promise<void>;
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
