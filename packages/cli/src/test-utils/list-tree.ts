import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Every path under dir, sorted, as a test compares two trees: `/` after a
// directory, `@` after a symlink and `*` after an executable file.
export async function listTree(dir: string): Promise<string[]> {
  const names = await readdir(dir, { recursive: true });

  const marked = await Promise.all(
    names.map(async (name) => {
      const stats = await lstat(join(dir, name));

      if (stats.isSymbolicLink()) {
        return `${name}@`;
      }

      if (stats.isDirectory()) {
        return `${name}/`;
      }

      return (stats.mode & 0o111) === 0 ? name : `${name}*`;
    }),
  );

  return marked.toSorted();
}
