import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config';
import { buildSystemDrivePath } from './data-layout';
import type { SystemFilePaths } from './system-file-info';

// Copies the kernel and the system drive into <dataDir>/system; returns the
// paths imps boot with. Drives are content-addressed and never written over
// (docs/architecture/storage.md#system-files).
export function setupSystemFiles(config: Config): SystemFilePaths {
  if (config.kernelSource === null) {
    // renamed over: a VM that has the old file open keeps the old inode
    if (!existsSync(config.kernelPath)) {
      throw new Error(`${config.kernelPath} is missing and no source is configured`);
    }
  } else {
    requireSource(config.kernelSource);

    // renamed over: a VM that has the old file open keeps the old inode
    if (!existsSync(config.kernelPath) || !isSameContent(config.kernelSource, config.kernelPath)) {
      writeCopy(config.kernelSource, config.kernelPath);
    }
  }

  requireSource(config.systemDriveSource);

  // a sleeping VM's snapshot reopens its drive by path: the bytes there stay

  const sha256 = new Bun.CryptoHasher('sha256')
    .update(readFileSync(config.systemDriveSource))
    .digest('hex');

  const systemDrivePath = buildSystemDrivePath(config.dataDir, sha256);

  if (!existsSync(systemDrivePath)) {
    writeCopy(config.systemDriveSource, systemDrivePath);
  }

  return { kernelPath: config.kernelPath, systemDrivePath };
}

function requireSource(source: string): void {
  if (!existsSync(source)) {
    throw new Error(`${source} does not exist`);
  }
}

// a crash mid-copy leaves only the .new file, never a short target
function writeCopy(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, `${target}.new`);
  renameSync(`${target}.new`, target);
}

function isSameContent(a: string, b: string): boolean {
  return Bun.hash(readFileSync(a)) === Bun.hash(readFileSync(b));
}
