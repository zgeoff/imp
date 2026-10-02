import { chmodSync, lchownSync, mkdirSync, rmSync } from 'node:fs';
import { isDiskFullError } from '../api-errors';
import type { ImpContext } from '../imps/imp-context';
import type { LockedImp } from '../imps/imp-lock';
import type { ImpVmOps } from '../imps/imp-vm-ops';
import { readErrorMessage } from '../read-error-message';
import { buildSnapshotIdentity, writeSnapshotMeta } from '../sleep/snapshot-meta';
import { readVmIdentity } from '../sleep/vm-identity';
import { buildWatchdogSlot } from '../storage/data-layout';

// root in the container; the test's own uid in a unit test
const IMPD_USER = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

// The silent VM's memory, for a post-mortem, in a slot only the owner reads;
// the VM stops. Without room, or on a failed snapshot, it logs why and leaves
// the VM to the restart that follows.
export async function writeWatchdogSnapshot(
  context: ImpContext,
  ops: Pick<ImpVmOps, 'withSleepSlot'>,
  imp: LockedImp,
): Promise<void> {
  const paths = context.findPaths(imp.id);
  const slot = buildWatchdogSlot(paths.dir);
  const pid = imp.pid;

  if (pid === null) {
    return;
  }

  // the old slot goes first: its files count against the disk check
  rmSync(slot.snapshotDir, { recursive: true, force: true });

  const writeSlot = async () => {
    // a jailed VM opens the files impd makes in it, so it can pass through
    mkdirSync(slot.snapshotDir, { recursive: true, mode: 0o711 });

    const cgroup = context.cgroups.setup(imp.id, imp.cpu, imp.memoryMib);

    await ops.withSleepSlot(() => context.vms.sleepVm(pid, paths, cgroup, slot));

    writeSnapshotMeta(slot, {
      ...buildSnapshotIdentity(readVmIdentity(paths), context.identity),
      createdAt: Date.now(),
      memoryMib: imp.memoryMib,
      ramMib: 0,
    });

    // the VM's own files back to impd: only the owner reads them
    for (const file of [slot.vmstate, slot.memFile, slot.snapshotMeta]) {
      lchownSync(file, IMPD_USER.uid, IMPD_USER.gid);
      chmodSync(file, 0o600);
    }

    chmodSync(slot.snapshotDir, 0o700);
  };

  try {
    await context.diskBudget.withRoom(imp.memoryMib * 1024 * 1024, writeSlot);

    context.log(`impd: ${imp.name}: the watchdog kept its memory in ${slot.snapshotDir}`);
  } catch (error) {
    rmSync(slot.snapshotDir, { recursive: true, force: true });

    const what = isDiskFullError(error) ? 'no watchdog snapshot' : 'the watchdog snapshot failed';

    context.log(`impd: ${imp.name}: ${what}: ${readErrorMessage(error)}`);
  }
}
