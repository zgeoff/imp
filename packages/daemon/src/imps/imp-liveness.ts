import { findImpById, updateImpStateIf } from '../db/imps';
import type { ImpRecord, ImpStateChange } from '../db/imps';
import { hasSnapshot, readSnapshotMeta } from '../sleep/snapshot-meta';
import type { ImpPaths } from '../storage/data-layout';
import type { ImpContext } from './imp-context';

// A dead VM or a lost snapshot means stopped; a VM that died after its sleep
// wrote the snapshot means sleeping. An unlocked caller passes `canRepair`
// false while the imp is locked, so it never hides a VM a start just booted.
export async function checkLiveness(
  context: ImpContext,
  imp: ImpRecord,
  canRepair: boolean,
): Promise<ImpRecord> {
  const paths = context.findPaths(imp.id);
  const lostSnapshot = imp.state === 'sleeping' && !hasSnapshot(paths);

  const lostVm =
    imp.state === 'running' && (imp.pid === null || !context.vms.isVmAlive(imp.pid, paths));

  if ((!lostSnapshot && !lostVm) || !canRepair) {
    return imp;
  }

  const change = lostVm ? findSleptChange(imp, paths) : null;

  const repaired = await updateImpStateIf(
    context.db,
    imp.id,
    { state: imp.state, pid: imp.pid },
    change ?? { reason: 'repaired', state: 'stopped', pid: null },
  );

  if (repaired === undefined) {
    const current = await findImpById(context.db, imp.id);

    return current ?? imp;
  }

  const what = lostSnapshot ? 'the snapshot is gone' : 'firecracker is gone';

  context.log(`impd: ${imp.name}: ${what}; marked it ${repaired.state}`);

  return repaired;
}

// Sleeping when the snapshot on disk is newer than the imp's last activity,
// so this VM wrote it: impd stopped between the snapshot and the record. An
// older snapshot belongs to an earlier sleep and must not be resumed.
function findSleptChange(imp: ImpRecord, paths: ImpPaths): ImpStateChange | null {
  const meta = readSnapshotMeta(paths);

  if (meta === null || meta.createdAt <= imp.lastActiveAt.getTime()) {
    return null;
  }

  return { reason: 'repaired', state: 'sleeping', pid: null, sleptAt: new Date(meta.createdAt) };
}
