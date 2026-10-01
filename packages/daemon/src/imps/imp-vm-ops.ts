import { statSync } from 'node:fs';
import { updateImpActivity, updateImpState } from '../db/imps';
import type { ImpStateChange } from '../db/imps';
import { readErrorMessage } from '../read-error-message';
import {
  checkSnapshotMatch,
  readSnapshotMeta,
  removeSnapshot,
  writeSnapshotMeta,
} from '../sleep/snapshot-meta';
import type { ImpContext } from './imp-context';
import { toLockedImp } from './imp-lock';
import type { LockedImp } from './imp-lock';
import { requireTransition } from './imp-transitions';
import { createSemaphore } from './semaphore';

// snapshot writes put the whole mem file through the page cache
// (docs/sleep-findings.md gotcha 8): a few at a time
const SLEEP_CONCURRENCY = 2;

// The VM side of the lifecycle. Every operation takes a LockedImp: the caller
// holds the imp's lock, and the record it passes is fresh.
export interface ImpVmOps {
  // moves the record to another state, checked against the lifecycle
  readonly updateState: (imp: LockedImp, change: ImpStateChange) => Promise<LockedImp>;

  // the full text goes to the log, its first line to the record
  readonly writeFailure: (imp: LockedImp, error: unknown) => Promise<void>;

  // boots the imp's disk; a memory snapshot is dropped first
  readonly startImpVm: (imp: LockedImp) => Promise<LockedImp>;

  // agent shutdown, then the memory goes too: a stopped imp boots cold
  readonly stopImpVm: (imp: LockedImp) => Promise<LockedImp>;

  // snapshots the VM and stops it (DESIGN 2.8). A failed snapshot leaves the
  // VM running; a failure after the kill stops the imp.
  readonly sleepImpVm: (imp: LockedImp, reason: string) => Promise<LockedImp>;

  // the running imp, woken or booted first
  readonly requireRunningImp: (imp: LockedImp) => Promise<LockedImp>;
}

export function createImpVmOps(context: ImpContext): ImpVmOps {
  const sleepSlots = createSemaphore(SLEEP_CONCURRENCY);

  // a VM started now would outlive impd's last sleep pass
  const requireNotStopping = (): void => {
    if (context.isStopping()) {
      throw new Error('impd is stopping');
    }
  };

  const updateState = async (imp: LockedImp, change: ImpStateChange): Promise<LockedImp> => {
    if (change.state !== imp.state) {
      requireTransition(imp.state, change.state, `move to ${change.state}`);
    }

    const updated = await updateImpState(context.db, imp.id, change);

    return toLockedImp(imp, updated);
  };

  const writeFailure = async (imp: LockedImp, error: unknown): Promise<void> => {
    const message = readErrorMessage(error);

    context.log(`impd: ${imp.name}: ${message}`);

    await updateState(imp, { state: 'error', pid: null, error: message.split('\n')[0] ?? '' });
  };

  const startImpVm = async (imp: LockedImp): Promise<LockedImp> => {
    requireNotStopping();

    const paths = context.findPaths(imp.id);
    const address = context.findAddress(imp.slot);

    // a memory snapshot is only valid with the disk it was taken with
    removeSnapshot(paths);

    // a fresh guest's RSS starts small and grows; reserve part of its memory
    await context.admission?.admit({
      id: imp.id,
      name: imp.name,
      reserveMib: Math.ceil((imp.memoryMib * context.config.bootReservePercent) / 100),
      memoryMib: imp.memoryMib,
    });

    try {
      await context.taps.setupTap(address);

      const vm = await context.vms.startVm({
        firecrackerBin: context.config.firecrackerBin,
        kernelPath: context.config.kernelPath,
        systemDrivePath: context.config.systemDrivePath,
        paths,
        address,
        impId: imp.id,
        hostname: imp.name,
        vcpus: imp.vcpus,
        memoryMib: imp.memoryMib,
        dns: context.config.dns,
      });

      context.log(`impd: ${imp.name}: booted pid ${String(vm.pid)} ${formatTimings(vm.timings)}`);

      await updateImpActivity(context.db, imp.id, new Date());

      return await updateState(imp, {
        state: 'running',
        pid: vm.pid,
        error: null,
        sleptAt: null,
        firecrackerVersion: vm.firecrackerVersion,
      });
    } catch (error) {
      context.admission?.release(imp.id);

      await writeFailure(imp, error);

      throw error;
    }
  };

  const stopImpVm = async (imp: LockedImp): Promise<LockedImp> => {
    const paths = context.findPaths(imp.id);

    if (imp.pid !== null) {
      await context.vms.stopVm(imp.pid, paths, true);
    }

    removeSnapshot(paths);
    context.admission?.release(imp.id);

    return imp.state === 'stopped' ? imp : updateState(imp, { state: 'stopped', pid: null });
  };

  const sleepImpVm = async (imp: LockedImp, reason: string): Promise<LockedImp> => {
    requireTransition(imp.state, 'sleeping', 'sleep');

    const paths = context.findPaths(imp.id);
    const pid = imp.pid;

    if (pid === null) {
      throw new Error(`${imp.name} is running without a firecracker pid`);
    }

    const ramMib = context.readRamMib(pid, paths.apiSocket) ?? 0;
    const started = performance.now();

    try {
      const timings = await sleepSlots.run(() => context.vms.sleepVm(pid, paths));

      writeSnapshotMeta(paths, {
        ...context.readIdentity(),
        createdAt: Date.now(),
        memoryMib: imp.memoryMib,
        ramMib,
      });

      const sleepMs = Math.round(performance.now() - started);

      context.log(
        `impd: ${imp.name}: asleep in ${String(sleepMs)}ms (${reason}), ram ${String(ramMib)} MiB, mem file ${String(readDiskMib(paths.memFile))} MiB on disk, ${formatTimings(timings)}`,
      );
    } catch (error) {
      if (context.vms.isVmAlive(pid, paths)) {
        throw error;
      }

      context.log(
        `impd: ${imp.name}: sleep failed after firecracker stopped: ${readErrorMessage(error)}`,
      );

      removeSnapshot(paths);
      context.admission?.release(imp.id);

      await updateState(imp, { state: 'stopped', pid: null });

      throw error;
    }

    context.admission?.release(imp.id);

    return updateState(imp, { state: 'sleeping', pid: null, sleptAt: new Date() });
  };

  // resumes from the snapshot, or boots cold when there is none, it does not
  // match this host, or the load fails: the disk is always the truth
  const wakeImpVm = async (imp: LockedImp): Promise<LockedImp> => {
    requireNotStopping();

    const paths = context.findPaths(imp.id);
    const meta = readSnapshotMeta(paths);

    const mismatch =
      meta === null ? 'no snapshot' : checkSnapshotMatch(meta, context.readIdentity());

    if (meta === null || mismatch !== null) {
      context.log(`impd: ${imp.name}: cold boot instead of a wake: ${mismatch ?? 'no snapshot'}`);

      return startImpVm(imp);
    }

    // a woken VM faults its pages back in; it grows toward what it owned
    await context.admission?.admit({
      id: imp.id,
      name: imp.name,
      reserveMib: Math.max(meta.ramMib, context.config.wakeReserveMib),
      memoryMib: imp.memoryMib,
    });

    const started = performance.now();

    try {
      // a container restart takes the taps with it
      await context.taps.setupTap(context.findAddress(imp.slot));

      const vm = await context.vms.wakeVm({ firecrackerBin: context.config.firecrackerBin, paths });

      const wakeMs = Math.round(performance.now() - started);

      context.log(
        `impd: ${imp.name}: woke pid ${String(vm.pid)} in ${String(wakeMs)}ms ${formatTimings(vm.timings)}`,
      );

      await updateImpActivity(context.db, imp.id, new Date());

      return await updateState(imp, {
        state: 'running',
        pid: vm.pid,
        error: null,
        sleptAt: null,
        firecrackerVersion: vm.firecrackerVersion,
      });
    } catch (error) {
      context.log(
        `impd: ${imp.name}: ${readErrorMessage(error).split('\n')[0] ?? ''}; booting cold`,
      );

      context.admission?.release(imp.id);

      return startImpVm(imp);
    }
  };

  const requireRunningImp = async (imp: LockedImp): Promise<LockedImp> => {
    if (imp.state === 'running') {
      return imp;
    }

    if (imp.state === 'sleeping') {
      return wakeImpVm(imp);
    }

    requireTransition(imp.state, 'running', 'start');

    if (imp.pid !== null) {
      await context.vms.stopVm(imp.pid, context.findPaths(imp.id), false);
    }

    return startImpVm(imp);
  };

  return { updateState, writeFailure, startImpVm, stopImpVm, sleepImpVm, requireRunningImp };
}

// allocated size: the mem file is sparse after --dig-holes
function readDiskMib(path: string): number {
  try {
    return Math.round((statSync(path).blocks * 512) / 1_048_576);
  } catch {
    return 0;
  }
}

function formatTimings(timings: Readonly<Record<string, number>>): string {
  return Object.entries(timings)
    .map(([step, ms]) => `${step}=${String(ms)}ms`)
    .join(' ');
}
