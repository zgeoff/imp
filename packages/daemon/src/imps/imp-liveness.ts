import { findImpById, updateImpStateIf } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { hasSnapshot } from '../sleep/snapshot-meta';
import type { ImpContext } from './imp-context';

// A dead VM or a lost snapshot means stopped. The repair is a compare-and-set,
// and an unlocked caller passes `canRepair` false while someone else holds
// the imp's lock, so it never hides a VM that a start just booted.
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

  const repaired = await updateImpStateIf(
    context.db,
    imp.id,
    { state: imp.state, pid: imp.pid },
    { state: 'stopped', pid: null },
  );

  if (repaired === undefined) {
    const current = await findImpById(context.db, imp.id);

    return current ?? imp;
  }

  const what = lostSnapshot ? 'the snapshot is gone' : 'firecracker is gone';

  context.log(`impd: ${imp.name}: ${what}; marked it stopped`);

  return repaired;
}
