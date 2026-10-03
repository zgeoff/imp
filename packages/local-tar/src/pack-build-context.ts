import { existsSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import ignore from '@balena/dockerignore';
import type { LocalEntry } from './pack-local-path';
import { listDockerfileCandidates } from './write-build-context';

export class MissingDockerfileError extends Error {
  override readonly name = 'MissingDockerfileError';
}

const ENTRY_KINDS = [
  ['directory', 'isDirectory'],
  ['symlink', 'isSymbolicLink'],
  ['file', 'isFile'],
] as const;

// The context as `docker buildx build <dir>` sends it, by path in the context, parents first.
// The ignore file is `<Dockerfile>.dockerignore` when there is one, else `.dockerignore`, and
// it may leave itself out. The Dockerfile always goes: docker reads it from the tar.
export function listContextEntries(
  root: string,
  dockerfile: string,
): Promise<readonly LocalEntry[]> {
  // the frontend reads `dockerfile` beside a missing `Dockerfile`
  const found = listDockerfileCandidates(posix.normalize(dockerfile)).find((candidate) =>
    existsSync(join(root, candidate)),
  );

  // a rejection, not a throw: callers catch on the promise
  if (found === undefined) {
    return Promise.reject(new MissingDockerfileError(`there is no ${dockerfile} in ${root}`));
  }

  return listEntries(root, found);
}

async function listEntries(root: string, dockerfile: string): Promise<readonly LocalEntry[]> {
  const ignoreName = existsSync(join(root, `${dockerfile}.dockerignore`))
    ? `${dockerfile}.dockerignore`
    : '.dockerignore';

  const patterns = existsSync(join(root, ignoreName))
    ? await readFile(join(root, ignoreName), 'utf8')
    : '';

  const matcher = ignore().add(patterns);

  // with no `!` exception, nothing under an ignored directory comes back
  const hasExceptions = patterns.split('\n').some((line) => line.trim().startsWith('!'));

  // `./Dockerfile` names the entry `Dockerfile`
  const dockerfileName = posix.normalize(dockerfile);
  const isDockerfileBelow = (dir: string): boolean => dockerfileName.startsWith(`${dir}/`);

  const collectEntries = async (dir: string, prefix: string): Promise<LocalEntry[]> => {
    const entries: LocalEntry[] = [];

    const children = await readdir(dir);

    for (const child of children.toSorted()) {
      const path = join(dir, child);
      const name = prefix === '' ? child : `${prefix}/${child}`;

      const stats = await lstat(path);

      const ignored = matcher.ignores(name) && name !== dockerfileName;

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
      if (hasExceptions || isDockerfileBelow(name)) {
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
