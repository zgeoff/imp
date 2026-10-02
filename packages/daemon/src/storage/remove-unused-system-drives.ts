import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildSystemDrivesDir } from './data-layout';

// Deletes every system drive whose file name is not in `keep`, and any copy a
// crash cut short; returns the names it deleted. Names, not paths: a moved
// data dir must not delete a drive in use.
export function removeUnusedSystemDrives(dataDir: string, keep: ReadonlySet<string>): string[] {
  const dir = buildSystemDrivesDir(dataDir);
  const removed: string[] = [];

  for (const name of readNames(dir)) {
    if (!keep.has(name)) {
      rmSync(join(dir, name), { force: true });

      removed.push(name);
    }
  }

  return removed;
}

function readNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
