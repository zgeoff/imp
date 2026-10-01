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
  const snapshotDir = join(dir, 'snapshot');

  return {
    dir,
    runDir,
    disk: join(dir, 'disk.ext4'),
    apiSocket: join(runDir, 'api.sock'),
    vsockSocket: join(runDir, 'vsock.sock'),
    logFile: join(runDir, 'firecracker.log'),
    pidFile: join(runDir, 'pid'),
    snapshotDir,
    vmstate: join(snapshotDir, 'vmstate'),
    memFile: join(snapshotDir, 'mem'),
    snapshotMeta: join(snapshotDir, 'meta.json'),
    checkpointsDir: join(dir, 'checkpoints'),
  };
}

// `digest` is the docker image ID; its `sha256:` prefix stays out of the path
export function buildImagePaths(dataDir: string, digest: string): ImagePaths {
  const dir = join(dataDir, 'images', digest.replace(/^sha256:/, ''));

  return { dir, rootfs: join(dir, 'rootfs.ext4'), config: join(dir, 'config.json') };
}
