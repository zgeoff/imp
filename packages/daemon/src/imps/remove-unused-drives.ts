import { basename } from 'node:path';
import { listImps } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { readLoadingMeta, readSnapshotMeta } from '../sleep/snapshot-meta';
import { readVmIdentity } from '../sleep/vm-identity';
import type { ImpPaths } from '../storage/data-layout';
import { removeUnusedSystemDrives } from '../storage/remove-unused-system-drives';

// Run once at start, after the imps are reconciled and before anything can
// boot or sleep one; returns the names of the drives it deleted.
export async function removeUnusedDrives(
  db: ImpDatabase,
  dataDir: string,
  findPaths: (impId: string) => ImpPaths,
  currentDrivePath: string,
  templateDrivePaths: readonly string[] = [],
): Promise<string[]> {
  const keep = await listDrivesInUse(db, findPaths);

  keep.add(basename(currentDrivePath));

  // a boot template reopens its drive on every restore
  for (const path of templateDrivePaths) {
    keep.add(basename(path));
  }

  return removeUnusedSystemDrives(dataDir, keep);
}

// The file names (sha256) of the drives that must stay: the one each snapshot
// reopens on a wake, and the one each live VM boots from, which its next sleep
// records. A VM impd could not stop keeps its pid on an error record.
async function listDrivesInUse(
  db: ImpDatabase,
  findPaths: (impId: string) => ImpPaths,
): Promise<Set<string>> {
  const drives = new Set<string>();

  for (const imp of await listImps(db)) {
    const paths = findPaths(imp.id);
    const meta = readSnapshotMeta(paths) ?? readLoadingMeta(paths);

    if (meta?.systemDrivePath !== undefined) {
      drives.add(basename(meta.systemDrivePath));
    }

    const vm = imp.pid === null ? null : readVmIdentity(paths);

    if (vm !== null) {
      drives.add(basename(vm.systemDrivePath));
    }
  }

  return drives;
}
