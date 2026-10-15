import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface CountTreeBytesDeps {
  // the real listing by default; tests list a directory too wide to make
  readonly readDir?: (dir: string) => Promise<Dirent[]>;
}

// The disk a tree's files take, less the 512-byte dnode slot ZFS shows in a
// file's blocks before its free space drops; a hard link counts once, and a
// symlink is never followed, as Bun's recursive readdir follows one
export async function countTreeBytes(root: string, deps: CountTreeBytesDeps = {}): Promise<number> {
  const readDir = deps.readDir ?? readDirEntries;

  const inodes = new Map<string, number>();

  const dirs = [root];

  // off the event loop, one directory's entries at a time
  for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
    const entries = await readEntries(readDir, dir);

    // one at a time, as a spread of a wide directory's subdirectories passes
    // the engine's argument limit
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(join(dir, entry.name));
      }
    }

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

function readDirEntries(dir: string): Promise<Dirent[]> {
  return readdir(dir, { withFileTypes: true });
}

// a directory gone since its listing, or never made, holds nothing
async function readEntries(
  readDir: (dir: string) => Promise<Dirent[]>,
  dir: string,
): Promise<Dirent[]> {
  try {
    return await readDir(dir);
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
