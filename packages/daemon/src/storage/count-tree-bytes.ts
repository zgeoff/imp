import type { Dirent } from 'node:fs';
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

    const stats = await Promise.all(
      files.map((entry) => lstat(join(dir, entry.name)).catch(readMissingAsUndefined)),
    );

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
    return readMissingAsUndefined(error) ?? [];
  }
}

// an entry gone since its listing counts nothing
function readMissingAsUndefined(error: unknown): undefined {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    return undefined;
  }

  throw error;
}
