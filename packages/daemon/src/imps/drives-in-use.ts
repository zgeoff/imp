import { listImps } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { readSnapshotMeta } from '../sleep/snapshot-meta';
import { readVmIdentity } from '../sleep/vm-identity';
import { buildImpPaths } from '../storage/data-layout';

// The system drives that must stay: the one each snapshot reopens on a wake,
// and the one each live VM boots from, which its next sleep records. A VM
// impd could not stop keeps its pid on an error record, and counts too.
export async function listDrivesInUse(db: ImpDatabase, dataDir: string): Promise<Set<string>> {
  const drives = new Set<string>();

  for (const imp of await listImps(db)) {
    const paths = buildImpPaths(dataDir, imp.id);
    const meta = readSnapshotMeta(paths);

    if (meta?.systemDrivePath !== undefined) {
      drives.add(meta.systemDrivePath);
    }

    const vm = imp.pid === null ? null : readVmIdentity(paths);

    if (vm !== null) {
      drives.add(vm.systemDrivePath);
    }
  }

  return drives;
}
