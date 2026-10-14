import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// The disk a tree's files take, less the 512-byte dnode slot ZFS shows in a
// file's blocks before its free space drops; a hard link counts once, and a
// symlink is never followed, as Bun's recursive readdir follows one
export async function countTreeBytes(root: string): Promise<number> {
  const inodes = new Map<string, number>();

  const dirs = [root];

  // off the event loop, one directory's entries at a time
  for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
    const entries = await readEntries(dir);

    dirs.push(
      ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name)),
    );

    const files = entries.filter((entry) => entry.isFile());

    const stats = await Promise.all(files.map((entry) => readFileStats(join(dir, entry.name))));

    for (const stat of stats) {
      if (stat !== undefined) {
        inodes.set(`${String(stat.dev)}:${String(stat.ino)}`, Math.max(0, stat.blocks - 1) * 512);
      }
    }
  }

  return [...inodes.values()].reduce((sum, bytes) => sum + bytes, 0);
}

// a directory gone since its listing, or never made, holds nothing
async function readEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }

    throw error;
  }
}

// a file gone since its listing counts nothing
async function readFileStats(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }

    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
