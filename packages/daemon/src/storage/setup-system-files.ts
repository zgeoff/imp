import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config';
import { buildSystemDrivePath } from './data-layout';
import { deriveFileSha256, readKernelInfo } from './system-file-info';
import type { SystemFileInfo } from './system-file-info';

// The files imps boot with, and what system.info reports about them.
export interface SystemFiles {
  readonly kernelPath: string;
  readonly systemDrivePath: string;
  readonly info: SystemFileInfo;
}

// Copies the kernel and the system drive into <dataDir>/system; each is
// hashed once here. Drives are content-addressed and never written over
// (docs/architecture/storage.md#system-files).
export async function setupSystemFiles(config: Config): Promise<SystemFiles> {
  const kernelSource = config.kernelSource ?? config.kernelPath;

  if (!existsSync(kernelSource)) {
    const missing = config.kernelSource === null ? ' and no source is configured' : '';

    throw new Error(`${kernelSource} does not exist${missing}`);
  }

  const kernel = readFileSync(kernelSource);
  const guestKernel = readKernelInfo(kernel);

  // renamed over: a VM that has the old file open keeps the old inode
  if (config.kernelSource !== null && !hasContent(config.kernelPath, kernel)) {
    writeCopy(config.kernelSource, config.kernelPath);
  }

  if (!existsSync(config.systemDriveSource)) {
    throw new Error(`${config.systemDriveSource} does not exist`);
  }

  const sha256 = await deriveFileSha256(config.systemDriveSource);

  // a sleeping VM's snapshot reopens its drive by path: the bytes there stay
  const systemDrivePath = buildSystemDrivePath(config.dataDir, sha256);

  if (!existsSync(systemDrivePath)) {
    writeCopy(config.systemDriveSource, systemDrivePath);
  }

  return {
    kernelPath: config.kernelPath,
    systemDrivePath,
    info: { guestKernel, systemDrive: { sha256 } },
  };
}

// compared byte for byte: the source is hashed once already
function hasContent(path: string, content: Uint8Array): boolean {
  return existsSync(path) && Buffer.from(content).equals(readFileSync(path));
}

// a crash mid-copy leaves only the .new file, never a short target
function writeCopy(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, `${target}.new`);
  renameSync(`${target}.new`, target);
}
