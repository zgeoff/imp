import { join } from 'node:path';
import type { FirecrackerPaths } from '../vmm/firecracker-process';

// The /var/lib/imp layout (DESIGN 2.4).

export interface ImpPaths extends FirecrackerPaths {
  readonly dir: string;
  readonly runDir: string;
  readonly disk: string;
  readonly snapshotDir: string;

  // the memory snapshot of a sleeping imp (docs/sleep-findings.md)
  readonly vmstate: string;
  readonly memFile: string;
  readonly snapshotMeta: string;

  // what the VM booted with; outside snapshotDir, which a cold boot clears
  readonly vmIdentity: string;
  readonly checkpointsDir: string;
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
  };
}

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

// System drives are named by their sha256 and never written over: a sleeping
// VM's snapshot reopens its drive by path, so the bytes there must stay.
export function buildSystemDrivesDir(dataDir: string): string {
  return join(dataDir, 'system', 'drives');
}

export function buildSystemDrivePath(dataDir: string, sha256: string): string {
  return join(buildSystemDrivesDir(dataDir), `${sha256}.squashfs`);
}
