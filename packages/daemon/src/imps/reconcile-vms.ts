import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeUnknownBoot } from '../db/cold-boots';
import { updateImpActivity } from '../db/imps';
import { readErrorMessage } from '../read-error-message';
import {
  readLoadingMeta,
  readSnapshotMeta,
  removeSnapshot,
  removeSnapshotMeta,
  resetSnapshotLoading,
} from '../sleep/snapshot-meta';
import { buildImpPaths, buildWatchdogSlot } from '../storage/data-layout';
import type { ImpPaths } from '../storage/data-layout';
import { isImpVm } from '../vmm/firecracker-process';
import type { ImpContext } from './imp-context';
import type { LockedImp } from './imp-lock';
import type { ImpVmOps } from './imp-vm-ops';

// What a restart makes of the VMs the last impd left: every Firecracker on an
// imp's API socket and of its owner (isImpVm), found by its pid file or in
// /proc, that no record owns.
export interface VmReconciler {
  // under the imp's lock: kills the VMs its record does not own, resumes one
  // a cut sleep left paused, and adopts one a cut wake left running
  readonly reconcileImp: (imp: LockedImp) => Promise<LockedImp>;

  // Firecrackers on the socket of an imp that has no record at all
  readonly killUnknownVms: (ids: ReadonlySet<string>) => Promise<void>;
}

// how long GET / may stay silent before a VM counts as dead: Firecracker
// answers nothing while it loads a large snapshot
const STATE_WAIT_MS = 10_000;
const STATE_RETRY_MS = 250;

export function createVmReconciler(context: ImpContext, ops: ImpVmOps): VmReconciler {
  const readVmStateWithin = async (paths: ImpPaths) => {
    const deadline = Date.now() + STATE_WAIT_MS;

    for (;;) {
      const state = await context.vms.readVmState(paths);

      if (state !== null || Date.now() >= deadline) {
        return state;
      }

      await Bun.sleep(STATE_RETRY_MS);
    }
  };

  // the pid file a start wrote, and every process on the exact socket: impd
  // can die before the file, and a retried start leaves two. Either is the
  // imp's only when its owner is.
  const findVms = (imp: LockedImp, paths: ImpPaths): number[] => {
    const pids = new Set(
      context.vms
        .listVms()
        .filter((vm) => vm.apiSocket === paths.apiSocket && isImpVm(vm.owner, imp.id, imp.jailUid))
        .map((vm) => vm.pid),
    );

    const filed = context.vms.readPid(paths);

    if (
      filed !== null &&
      context.vms.isVmAlive(filed, paths) &&
      isImpVm(context.vms.readVmOwner(filed), imp.id, imp.jailUid)
    ) {
      pids.add(filed);
    }

    return [...pids].toSorted((a, b) => a - b);
  };

  // false when the VM survived SIGKILL
  const stopOrphan = async (name: string, pid: number, paths: ImpPaths): Promise<boolean> => {
    try {
      await context.vms.stopVm(pid, paths, false);

      context.log(`impd: ${name}: killed firecracker pid ${String(pid)}, which no record owns`);

      return true;
    } catch (error) {
      context.log(`impd: ${name}: could not kill pid ${String(pid)}: ${readErrorMessage(error)}`);

      return false;
    }
  };

  // The VM a wake left when impd died: the load ran unless GET / says it
  // never started. One that loaded gets the rest of the wake; one that fails
  // it ran the guest, which may have written the disk, so the snapshot goes.
  const wakeOrphan = async (imp: LockedImp, paths: ImpPaths, pid: number): Promise<LockedImp> => {
    const state = await readVmStateWithin(paths);

    const loading = readLoadingMeta(paths);

    // the guest never ran, so its disk is as the snapshot left it
    if (state === 'Not started') {
      await stopOrphan(imp.name, pid, paths);

      if (loading !== null) {
        resetSnapshotLoading(paths);
      }

      return imp;
    }

    const meta = loading ?? readSnapshotMeta(paths);

    try {
      if (state === null) {
        throw new Error('its API does not answer');
      }

      if (state === 'Paused') {
        await context.vms.resumeVm(pid, paths);
      }

      await context.admission?.admit({
        id: imp.id,
        name: imp.name,
        reserveMib: Math.max(meta?.ramMib ?? 0, context.config.wakeReserveMib),
        memoryMib: imp.maxMemoryMib,
      });

      const woken = await context.vms.finishWake(paths);

      if (meta?.agentVersion !== undefined && woken.agentVersion !== meta.agentVersion) {
        throw new Error(`the agent answered as ${woken.agentVersion}, not ${meta.agentVersion}`);
      }

      context.log(`impd: ${imp.name}: adopted firecracker pid ${String(pid)}, which a wake left`);

      await updateImpActivity(context.db, imp.id, new Date());

      if (woken.bootId !== undefined) {
        await writeUnknownBoot(context.db, imp.id, woken.bootId, new Date());
      }

      const running = await ops.updateState(imp, {
        reason: 'adopted',
        state: 'running',
        pid,
        error: null,
        sleptAt: null,
        firecrackerVersion: woken.firecrackerVersion,
      });

      removeSnapshotMeta(paths);

      return running;
    } catch (error) {
      context.log(
        `impd: ${imp.name}: cannot adopt the VM a wake left: ${readErrorMessage(error)}; it boots cold next`,
      );

      context.admission?.release(imp.id);
      removeSnapshot(paths);

      // a VM that will not die keeps its pid on the record, so a start or a
      // destroy kills it again
      if (!(await stopOrphan(imp.name, pid, paths))) {
        return ops.updateState(imp, {
          reason: 'failed',
          state: 'error',
          pid,
          error: 'could not stop a VM a wake left',
        });
      }

      return ops.updateState(imp, {
        reason: 'repaired',
        state: 'stopped',
        pid: null,
        nextBootCause: 'wake_fallback',
      });
    }
  };

  // a sleep resumes a paused VM when its snapshot fails; one cut short by
  // impd's death never did
  const checkPaused = async (imp: LockedImp, paths: ImpPaths): Promise<void> => {
    if (imp.pid === null || (await context.vms.readVmState(paths)) !== 'Paused') {
      return;
    }

    try {
      await context.vms.resumeVm(imp.pid, paths);

      context.log(`impd: ${imp.name}: resumed the VM a cut sleep left paused`);
    } catch (error) {
      context.log(`impd: ${imp.name}: could not resume its paused VM: ${readErrorMessage(error)}`);
    }
  };

  return {
    reconcileImp: async (imp) => {
      const paths = context.findPaths(imp.id);

      removePartialFiles(paths);

      // a running, creating or failed record owns its pid
      const owned = imp.state === 'sleeping' || imp.state === 'stopped' ? null : imp.pid;
      const orphans = findVms(imp, paths).filter((pid) => pid !== owned);
      const [only] = orphans;

      if (imp.state === 'sleeping' && only !== undefined && orphans.length === 1) {
        return wakeOrphan(imp, paths, only);
      }

      for (const pid of orphans) {
        await stopOrphan(imp.name, pid, paths);
      }

      // more than one wake ran: whichever loaded, the snapshot is spent
      if (imp.state === 'sleeping' && orphans.length > 1) {
        removeSnapshot(paths);

        return ops.updateState(imp, {
          reason: 'repaired',
          state: 'stopped',
          pid: null,
          nextBootCause: 'wake_fallback',
        });
      }

      // a load ran and its VM is gone: the guest may have written its disk
      if (imp.state === 'sleeping' && readLoadingMeta(paths) !== null) {
        context.log(`impd: ${imp.name}: a wake was cut and its VM is gone; it boots cold next`);

        removeSnapshot(paths);

        return ops.updateState(imp, {
          reason: 'repaired',
          state: 'stopped',
          pid: null,
          nextBootCause: 'wake_fallback',
        });
      }

      if (imp.state === 'running') {
        await checkPaused(imp, paths);
      }

      return imp;
    },

    killUnknownVms: async (ids) => {
      const dataDir = context.config.dataDir;

      for (const vm of context.vms.listVms()) {
        const id = parseImpId(dataDir, vm.apiSocket);

        if (id !== null && !ids.has(id) && isImpVm(vm.owner, id, null)) {
          await stopOrphan(id, vm.pid, buildImpPaths(dataDir, id));
        }
      }
    },
  };
}

// what a crash can leave half written: a sleep's new snapshot files, and the
// next version of a record that is renamed over the old one
function removePartialFiles(paths: ImpPaths): void {
  const slot = buildWatchdogSlot(paths.dir);

  for (const path of [
    paths.vmstate,
    paths.memFile,
    paths.snapshotMeta,
    paths.vmIdentity,
    slot.vmstate,
    slot.memFile,
    slot.snapshotMeta,
  ]) {
    rmSync(`${path}.new`, { force: true });
  }
}

// the imp id when `apiSocket` is exactly the socket of one under `dataDir`
function parseImpId(dataDir: string, apiSocket: string): string | null {
  const prefix = `${join(dataDir, 'imps')}/`;

  if (!apiSocket.startsWith(prefix)) {
    return null;
  }

  const [id = ''] = apiSocket.slice(prefix.length).split('/');

  return id !== '' && buildImpPaths(dataDir, id).apiSocket === apiSocket ? id : null;
}
