import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config';

// Copies the configured kernel and system drive into <dataDir>/system. A
// changed file is written next to the old one and renamed over it, so a VM
// that has the old one open keeps reading the old inode.
export function setupSystemFiles(config: Config): void {
  const pairs: readonly (readonly [string | null, string])[] = [
    [config.kernelSource, config.kernelPath],
    [config.systemDriveSource, config.systemDrivePath],
  ];

  for (const [source, target] of pairs) {
    if (source === null) {
      if (!existsSync(target)) {
        throw new Error(`${target} is missing and no source is configured`);
      }

      continue;
    }

    if (!existsSync(source)) {
      throw new Error(`${source} does not exist`);
    }

    if (existsSync(target) && isSameContent(source, target)) {
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, `${target}.new`);
    renameSync(`${target}.new`, target);
  }
}

function isSameContent(a: string, b: string): boolean {
  return Bun.hash(readFileSync(a)) === Bun.hash(readFileSync(b));
}
