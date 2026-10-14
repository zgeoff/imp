import { lstatSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

// The disk a tree's files take, less the 512-byte dnode slot ZFS shows in a
// file's blocks before its free space drops; a hard link counts once, and a
// symlink is never followed, as Bun's recursive readdir follows one
export function countTreeBytes(root: string): number {
  const inodes = new Map<string, number>();

  const dirs = [root];

  for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
    for (const entry of readEntries(dir)) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        dirs.push(path);
      } else if (entry.isFile()) {
        const stats = lstatSync(path, { throwIfNoEntry: false });

        if (stats !== undefined) {
          inodes.set(
            `${String(stats.dev)}:${String(stats.ino)}`,
            Math.max(0, stats.blocks - 1) * 512,
          );
        }
      }
    }
  }

  return [...inodes.values()].reduce((sum, bytes) => sum + bytes, 0);
}

// a directory gone since its listing, or never made, holds nothing
function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}
