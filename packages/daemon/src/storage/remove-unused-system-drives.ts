import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildSystemDrivesDir } from './data-layout';

// Deletes every system drive not in `keep`, and any copy a crash cut short;
// returns the names it deleted. `keep` holds the current drive and every
// drive a snapshot or a live VM names.
export function removeUnusedSystemDrives(dataDir: string, keep: ReadonlySet<string>): string[] {
  const dir = buildSystemDrivesDir(dataDir);
  const removed: string[] = [];

  for (const name of readNames(dir)) {
    const path = join(dir, name);

    if (!keep.has(path)) {
      rmSync(path, { force: true });

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
