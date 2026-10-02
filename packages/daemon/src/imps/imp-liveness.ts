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
    change ?? {
      reason: 'repaired',
      state: 'stopped',
      pid: null,
      awakeUntil: findLastSeenAlive(context, imp),
    },
  );

  if (repaired === undefined) {
    const current = await findImpById(context.db, imp.id);

    return current ?? imp;
  }

  const what = lostSnapshot ? 'the snapshot is gone' : 'firecracker is gone';

  context.log(`impd: ${imp.name}: ${what}; marked it ${repaired.state}`);

  // a stopped imp needs no cgroup; a sleeping one wakes into it
  if (repaired.state === 'stopped') {
    await context.cgroups.remove(imp.id);
  }

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

  const sleptAt = new Date(meta.createdAt);

  return { reason: 'repaired', state: 'sleeping', pid: null, sleptAt, awakeUntil: sleptAt };
}

// A dead VM's awake span ends when anything last saw it alive: impd's last
// sample or the imp's last activity, not when the repair ran.
function findLastSeenAlive(context: ImpContext, imp: Readonly<ImpRecord>): Date {
  const sampled = context.resources.readLastSeenAt(imp.id)?.getTime() ?? 0;

  return new Date(Math.max(sampled, imp.lastActiveAt.getTime()));
}
