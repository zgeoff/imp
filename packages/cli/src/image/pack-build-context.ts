import { existsSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import ignore from '@balena/dockerignore';
import type { LocalEntry } from '../cp/pack-local-path';
import { UsageError } from '../usage-error';

const ENTRY_KINDS = [
  ['directory', 'isDirectory'],
  ['symlink', 'isSymbolicLink'],
  ['file', 'isFile'],
] as const;

// The context as `docker build` sends it, by path in the context, parents first. The ignore
// file is `<Dockerfile>.dockerignore` when there is one, else `.dockerignore`; like the docker
// CLI, the Dockerfile and the ignore file always go.
export async function listContextEntries(
  root: string,
  dockerfile: string,
): Promise<readonly LocalEntry[]> {
  if (!existsSync(join(root, dockerfile))) {
    throw new UsageError(`there is no ${dockerfile} in ${root}`);
  }

  const ignoreName = existsSync(join(root, `${dockerfile}.dockerignore`))
    ? `${dockerfile}.dockerignore`
    : '.dockerignore';

  const patterns = existsSync(join(root, ignoreName))
    ? await readFile(join(root, ignoreName), 'utf8')
    : '';

  const matcher = ignore().add(patterns);

  const kept = new Set([dockerfile, ignoreName, '.dockerignore']);

  // with no `!` exception, nothing under an ignored directory comes back
  const hasExceptions = patterns.split('\n').some((line) => line.trim().startsWith('!'));

  const isKeptBelow = (dir: string): boolean =>
    [...kept].some((path) => path.startsWith(`${dir}/`));

  const collectEntries = async (dir: string, prefix: string): Promise<LocalEntry[]> => {
    const entries: LocalEntry[] = [];

    const children = await readdir(dir);

    for (const child of children.toSorted()) {
      const path = join(dir, child);
      const name = prefix === '' ? child : `${prefix}/${child}`;

      const stats = await lstat(path);

      const ignored = matcher.ignores(name) && !kept.has(name);

      const entry: LocalEntry = {
        path,
        name,
        kind: ENTRY_KINDS.find(([, check]) => stats[check]())?.[0] ?? 'other',
        size: stats.size,
        mode: stats.mode & 0o7777,
        mtimeMs: stats.mtimeMs,
      };

      if (entry.kind !== 'directory') {
        if (!ignored) {
          entries.push(entry);
        }

        continue;
      }

      if (!ignored) {
        entries.push(entry, ...(await collectEntries(path, name)));
        continue;
      }

      // an ignored directory goes only as the parent of what comes back
      if (hasExceptions || isKeptBelow(name)) {
        const below = await collectEntries(path, name);

        if (below.length > 0) {
          entries.push(entry, ...below);
        }
      }
    }

    return entries;
  };

  return collectEntries(root, '');
}
