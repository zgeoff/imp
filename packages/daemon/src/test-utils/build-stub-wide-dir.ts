import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// countTreeBytes' readDir over a real tree, where `dir` also lists `count`
// empty subdirectories, `sub-0` on, that are on no disk: a directory too wide
// for a test to make. Every other directory lists as readdir does.
export function buildStubWideDir(dir: string, count: number) {
  const generated = new Set(Array.from({ length: count }, (_, index) => join(dir, `sub-${index}`)));

  const readDir = async (path: string): Promise<Dirent[]> => {
    if (generated.has(path)) {
      return [];
    }

    const entries = await readdir(path, { withFileTypes: true });

    if (path !== dir) {
      return entries;
    }

    for (let index = 0; index < count; index++) {
      entries.push(buildDirEntry(dir, `sub-${index}`));
    }

    return entries;
  };

  return { readDir };
}

function buildDirEntry(parentPath: string, name: string): Dirent {
  return {
    name,
    parentPath,
    isFile: () => false,
    isDirectory: () => true,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}
