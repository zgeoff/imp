import type { ImpPaths } from './data-layout';

export type StorageBackendKind = 'xfs' | 'zfs';

// Where a new imp disk comes from. An imp source is its live disk: the caller
// freezes the guest around the call.
export type DiskSource =
  | { readonly kind: 'image'; readonly digest: string }
  | { readonly kind: 'imp'; readonly impId: string }
  | { readonly kind: 'checkpoint'; readonly impId: string; readonly checkpointId: string };

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

// The disks, checkpoints and image rootfs files of imps (docs/architecture/
// storage.md). XFS clones files with reflink; ZFS keeps each disk in a
// dataset, a checkpoint as a snapshot and a fork as a clone.
export interface StorageBackend {
  readonly kind: StorageBackendKind;

  // before any VM is re-adopted or woken: mounts, finishes or undoes a restore
  // a crash cut short, and drops what `live` does not name
  readonly start: (live: LiveStorage) => Promise<void>;

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

  readonly readUsage: () => Promise<StorageUsage>;
}
