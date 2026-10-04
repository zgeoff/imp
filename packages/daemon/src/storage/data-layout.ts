import { join } from 'node:path';
import type { FirecrackerPaths } from '../vmm/firecracker-process';

// The /var/lib/imp layout (docs/architecture/storage.md#the-data-directory).

export interface ImpPaths extends FirecrackerPaths {
  readonly impId: string;
  readonly dir: string;
  readonly runDir: string;
  readonly disk: string;
  readonly snapshotDir: string;

  // the memory snapshot of a sleeping imp (docs/architecture/sleep-and-wake.md)
  readonly vmstate: string;
  readonly memFile: string;
  readonly snapshotMeta: string;

  // what the VM booted with; outside snapshotDir, which a cold boot clears
  readonly vmIdentity: string;
  readonly checkpointsDir: string;

  // impd's logs of the imp's sessions, one directory per generation
  // (docs/architecture/daemon.md#session-logs)
  readonly sessionLogsDir: string;
}

export interface ImagePaths {
  readonly dir: string;
  readonly rootfs: string;
  readonly config: string;
}

export function buildImpPaths(dataDir: string, impId: string): ImpPaths {
  const dir = join(dataDir, 'imps', impId);
  const runDir = join(dir, 'run');

  return {
    impId,
    dir,
    runDir,
    disk: join(dir, 'disk.ext4'),
    apiSocket: join(runDir, 'api.sock'),
    vsockSocket: join(runDir, 'vsock.sock'),
    logFile: join(runDir, 'firecracker.log'),
    pidFile: join(runDir, 'pid'),
    ...buildSnapshotPaths(join(dir, 'snapshot')),
    vmIdentity: join(dir, 'vm.json'),
    checkpointsDir: join(dir, 'checkpoints'),
    sessionLogsDir: join(dir, 'session-logs'),
  };
}

// The one memory snapshot the watchdog keeps of an imp whose agent went
// silent, for a post-mortem: in the imp's directory, which a destroy removes.
export function buildWatchdogSlot(impDir: string): SnapshotPaths {
  return buildSnapshotPaths(join(impDir, 'watchdog'));
}

// where a snapshot's files go: a sleeping imp's, or the watchdog's slot
export type SnapshotPaths = Readonly<ReturnType<typeof buildSnapshotPaths>>;

// the memory snapshot's files; ZFS keeps them in a dataset of their own
export function buildSnapshotPaths(snapshotDir: string) {
  return {
    snapshotDir,
    vmstate: join(snapshotDir, 'vmstate'),
    memFile: join(snapshotDir, 'mem'),
    snapshotMeta: join(snapshotDir, 'meta.json'),
  };
}

// `digest` is the docker image ID; its `sha256:` prefix stays out of the path
export function buildImagePaths(dataDir: string, digest: string): ImagePaths {
  const dir = join(dataDir, 'images', digest.replace(/^sha256:/, ''));

  return { dir, rootfs: join(dir, 'rootfs.ext4'), config: join(dir, 'config.json') };
}

// build contexts clients upload, each removed after its build
export function buildUploadsDir(dataDir: string): string {
  return join(dataDir, 'uploads');
}

// System drives are named by their sha256 and never written over: a sleeping
// VM's snapshot reopens its drive by path, so the bytes there must stay.
export function buildSystemDrivesDir(dataDir: string): string {
  return join(dataDir, 'system', 'drives');
}

export function buildSystemDrivePath(dataDir: string, sha256: string): string {
  return join(buildSystemDrivesDir(dataDir), `${sha256}.squashfs`);
}

// What impd's backups keep on the host (docs/architecture/backups.md).
export function buildBackupPaths(dataDir: string) {
  const dir = join(dataDir, 'backup');

  return {
    dir,

    // what restic reads: the manifest, and the disks, checkpoints and images
    // at the same paths every run; the database copy stays outside it
    tree: join(dir, 'tree'),
    cache: join(dir, 'cache'),

    // when forget, prune and check last ran
    state: join(dir, 'state.json'),

    // XFS: the source of each disk copy in the tree, to reuse an unchanged one
    copies: join(dir, 'copies.json'),
    restoreDir: join(dir, 'restore'),
  };
}

// Paths in the backup tree, relative to it: the same on XFS and ZFS, where
// each directory is a read-only clone of the dataset.
export const BACKUP_TREE = {
  manifest: 'manifest.json',
  buildImpDir: (impId: string) => join('imps', impId),
  buildDisk: (impId: string) => join('imps', impId, 'disk', 'rootfs.ext4'),
  buildCheckpointDisk: (impId: string, checkpointId: string) =>
    join('imps', impId, 'checkpoints', checkpointId, 'rootfs.ext4'),
  buildImageDir: (digest: string) => join('images', digest.replace(/^sha256:/, '')),
};
