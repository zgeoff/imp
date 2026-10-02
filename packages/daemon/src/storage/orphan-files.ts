import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { OrphanStorage } from './storage-backend';

// Anything in `dir` but empty directories: a socket or a log may be all an
// imp left, and only an empty directory is provably nothing
export function isHoldingFiles(dir: string): boolean {
  return (
    existsSync(dir) &&
    readdirSync(dir, { recursive: true, withFileTypes: true }).some((entry) => !entry.isDirectory())
  );
}

// every regular file under `dir`
export function listFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

// An orphan kept as a directory. Its size counts the blocks a reflink
// shares in full.
export function readDirectoryOrphan(
  kind: OrphanStorage['kind'],
  id: string,
  dir: string,
  snapshots: readonly string[],
): OrphanStorage {
  const birth = statSync(dir).birthtimeMs;

  return {
    kind,
    id,
    location: dir,
    bytes: listFilesUnder(dir).reduce((sum, path) => sum + statSync(path).blocks * 512, 0),
    createdAt: birth > 0 ? new Date(birth) : null,
    snapshots,
  };
}
