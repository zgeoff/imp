import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ImpEventDetail } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import { sendActivity } from '../agent-client/agent-requests';
import type { AgentSession } from '../agent-client/agent-requests';
import { sendServicesList } from '../agent-client/service-requests';
import { buildAgentOutdatedApiError } from '../api-errors';
import { removeIdentityReset, updateImpActivity, updateImpDisk, updateImpState } from '../db/imps';
import type { ImpStateChange } from '../db/imps';
import type { SlotAddress } from '../net/addressing';
import { readErrorMessage } from '../read-error-message';
import { waitForGuestAge } from '../sleep/guest-age';
import {
  buildSnapshotIdentity,
  findColdBootReason,
  readSnapshotMeta,
  removeSnapshot,
  removeSnapshotMeta,
  setSnapshotLoading,
  writeSnapshotMeta,
} from '../sleep/snapshot-meta';
import { readVmIdentity, writeVmIdentity } from '../sleep/vm-identity';
import type { VmIdentity } from '../sleep/vm-identity';
import type { ImpPaths } from '../storage/data-layout';
import type { StartedVm } from '../vmm/vm-runner';
import type { ImpContext } from './imp-context';
import { toLockedImp } from './imp-lock';
import type { LockedImp } from './imp-lock';
import { requireTransition } from './imp-transitions';
import { startCounting } from './read-running-imp-usage';
import { createSemaphore } from './semaphore';
import type { ShutdownGate } from './shutdown-gate';

// snapshot writes put the whole mem file through the page cache
// (docs/architecture/sleep-and-wake.md#4-gotchas, gotcha 8): a few at a time
const SLEEP_CONCURRENCY = 2;

// the claim's seed for the guest's entropy pool; the agent wants 32 or more
const CLAIM_SEED_BYTES = 64;

// how long a sleep waits for the services list it records
const SERVICES_FOR_SLEEP_MS = 1000;

// How a sleep treats a guest younger than IMP_SLEEP_MIN_GUEST_UPTIME_MS: wait
// for it, and give way once `isWanted` turns false, or sleep it at once.
export type YoungGuestWait =
  | { readonly wait: false }
  | { readonly wait: true; readonly isWanted: () => Promise<boolean> };

const ALWAYS_WAIT: YoungGuestWait = {
  wait: true,
  isWanted: () => Promise.resolve(true),
};

// The VM side of the lifecycle. Every operation takes a LockedImp: the caller
// holds the imp's lock, and the record it passes is fresh.
export interface ImpVmOps {
  // moves the record to another state, checked against the lifecycle
  readonly updateState: (imp: LockedImp, change: Readonly<ImpStateChange>) => Promise<LockedImp>;

  // the full text goes to the log, its first line to the record
  readonly writeFailure: (imp: LockedImp, error: unknown) => Promise<void>;

  // boots the imp's disk; a memory snapshot is dropped first
  readonly startImpVm: (imp: LockedImp) => Promise<LockedImp>;

  // agent shutdown, then the memory goes too: a stopped imp boots cold
  readonly stopImpVm: (imp: LockedImp) => Promise<LockedImp>;

  // snapshots the VM and stops it (docs/architecture/sleep-and-wake.md#sleep);
  // a failed snapshot leaves it running, a failure after the kill stops the
  // imp. A sleep that gives way to a busy imp returns it still running.
  readonly sleepImpVm: (
    imp: LockedImp,
    reason: string,
    youngGuest?: YoungGuestWait,
  ) => Promise<LockedImp>;

  // the running imp, woken or booted first
  readonly requireRunningImp: (imp: LockedImp) => Promise<LockedImp>;

  // a running guest grows its filesystem into a grown disk file; a failure
  // leaves the grow pending for the next wake, and a cold boot grows anyway
  readonly growGuestDisk: (imp: LockedImp) => Promise<LockedImp>;

  // kills the VM without asking its agent, which may not answer, and boots
  // the disk cold; `reason` says why on the imp
  readonly startFreshImpVm: (imp: LockedImp, reason: string) => Promise<LockedImp>;

  // runs a snapshot write in one of the host-wide sleep slots
  readonly withSleepSlot: <T>(task: () => Promise<T>) => Promise<T>;
}

export function createImpVmOps(context: ImpContext, gate: ShutdownGate): ImpVmOps {
  const sleepSlots = createSemaphore(SLEEP_CONCURRENCY);

  const updateState = async (
    imp: LockedImp,
    change: Readonly<ImpStateChange>,
  ): Promise<LockedImp> => {
    if (change.state !== imp.state) {
      requireTransition(imp.state, change.state, `move to ${change.state}`);
    }

    const updated = await updateImpState(context.db, imp.id, change);

    if (change.state !== 'running') {
      context.sessions.forget(imp.id);
    }

    return toLockedImp(imp, updated);
  };

  const writeFailure = async (imp: LockedImp, error: unknown): Promise<void> => {
    const message = readErrorMessage(error);

    context.log(`impd: ${imp.name}: ${message}`);

    await updateState(imp, {
      reason: 'failed',
      state: 'error',
      pid: null,
      error: message.split('\n')[0] ?? '',
    });
  };

  // The identity is advisory: a VM without one sleeps into a snapshot that
  // boots cold, so a failed write (a full disk) must not fail the boot.
  const writeIdentity = (imp: LockedImp, paths: ImpPaths, identity: VmIdentity): void => {
    try {
      writeVmIdentity(paths, identity);
    } catch (error) {
      context.log(`impd: ${imp.name}: could not write vm.json: ${readErrorMessage(error)}`);
    }
  };

  // A cold boot: a restore of the shape's boot template when one is ready,
  // else the kernel's boot. A template that fails to restore goes, and the
  // imp boots the kernel (docs/architecture/boot-templates.md#claim).
  const startColdVm = async (
    imp: LockedImp,
    paths: ImpPaths,
    address: SlotAddress,
    hostSteps: Readonly<Record<string, number>>,
  ): Promise<StartedVm> => {
    const cgroup = context.cgroups.setup(imp.id, imp.cpu);
    const template = context.templates?.find({ vcpus: imp.vcpus, memoryMib: imp.memoryMib });

    if (template !== null && template !== undefined) {
      try {
        const vm = await context.vms.loadTemplateVm({
          firecrackerBin: context.config.firecrackerBin,
          paths,
          vmstate: template.vmstate,
          memFile: template.memFile,
          diskPath: resolve(paths.disk),
          tap: address.tap,
          cgroup,
          claim: {
            id: imp.id,
            hostname: imp.name,
            ip: `${address.guestIp}/${String(address.prefixLength)}`,
            gw: address.hostIp,
            dns: context.config.dns,
            mac: address.guestMac,
            seed: randomBytes(CLAIM_SEED_BYTES),
            isIdentityReset: imp.isIdentityResetPending,
          },
        });

        context.log(
          `impd: ${imp.name}: restored boot template ${template.key.slice(0, 12)} as pid ${String(vm.pid)} ${formatTimings({ ...hostSteps, ...vm.timings })}`,
        );

        return vm;
      } catch (error) {
        context.log(
          `impd: ${imp.name}: boot template ${template.key.slice(0, 12)} failed, booting the kernel: ${readErrorMessage(error)}`,
        );

        context.templates?.discard(template.key);
      }
    }

    const vm = await context.vms.startVm({
      firecrackerBin: context.config.firecrackerBin,
      kernelPath: context.config.kernelPath,
      systemDrivePath: context.identity.systemDrivePath,
      paths,
      address,
      impId: imp.id,
      hostname: imp.name,
      vcpus: imp.vcpus,
      memoryMib: imp.memoryMib,
      dns: context.config.dns,
      cgroup,
      isIdentityReset: imp.isIdentityResetPending,
    });

    context.log(
      `impd: ${imp.name}: booted pid ${String(vm.pid)} ${formatTimings({ ...hostSteps, ...vm.timings })}`,
    );

    return vm;
  };

  // `reason` says why a wake booted cold instead; null for a create or a start
  // `isWake` when the boot stands in for a wake, which it counts as
  const startColdImpVm = async (
    imp: LockedImp,
    reason: string | null,
    isWake = false,
  ): Promise<LockedImp> => {
    try {
      gate.requireOpen();
    } catch (error) {
      // a create cut short by impd stopping shows why; any other imp keeps
      // the state it had
      if (imp.state === 'creating') {
        await writeFailure(imp, error);
      }

      throw error;
    }

    const paths = context.findPaths(imp.id);
    const address = context.findAddress(imp.slot);
    const admitStarted = performance.now();

    // a fresh guest's RSS starts small and grows; reserve part of its memory
    await context.admission?.admit({
      id: imp.id,
      name: imp.name,
      reserveMib: Math.ceil((imp.memoryMib * context.config.bootReservePercent) / 100),
      memoryMib: imp.memoryMib,
    });

    const setupStarted = performance.now();

    try {
      // a memory snapshot is only valid with the disk it was taken with. It
      // goes once the boot is admitted: a sleeping imp the budget turns away
      // keeps its memory.
      removeSnapshot(paths);

      // a box or none imp never runs where nft cannot hold it in
      await context.egress.requireImp(imp.id);
      await context.taps.setupTap(address);

      // the host's part before the VM, for the boot's log line
      const hostSteps = {
        admit: Math.round(setupStarted - admitStarted),
        setup: Math.round(performance.now() - setupStarted),
      };

      const vm = await startColdVm(imp, paths, address, hostSteps);

      startCounting(context, imp, vm.pid);

      // its sleeps record this, whatever the host boots by then
      writeIdentity(imp, paths, {
        ...context.identity,
        agentVersion: vm.agentVersion,
        bootReason: reason,
      });

      await updateImpActivity(context.db, imp.id, new Date());

      const running = await updateState(imp, {
        reason: 'booted',
        detail: {
          durationMs: countStepsMs(vm.timings),
          steps: vm.timings,
          ...(reason !== null && { coldBootReason: reason }),
        },
        ...(isWake && { countsWake: true }),
        state: 'running',
        pid: vm.pid,
        error: null,
        sleptAt: null,
        firecrackerVersion: vm.firecrackerVersion,
      });

      // the flag stays until a boot reports the reset done, so a failed
      // ssh-keygen is tried again on the next boot
      const reset =
        running.isIdentityResetPending && vm.identityReset === 'ok'
          ? await removeLockedIdentityReset(running)
          : running;

      if (reset.isIdentityResetPending) {
        context.log(
          `impd: ${imp.name}: the identity reset did not finish (${vm.identityReset ?? 'no report'}); the next boot tries again`,
        );
      }

      // stage 1 grew the filesystem to fill the disk
      return reset.isDiskGrowPending ? await setGrowPending(reset, false) : reset;
    } catch (error) {
      context.admission?.release(imp.id);

      await writeFailure(imp, error);

      throw error;
    }
  };

  const startImpVm = (imp: LockedImp): Promise<LockedImp> => startColdImpVm(imp, null);

  const stopImpVm = async (imp: LockedImp): Promise<LockedImp> => {
    const paths = context.findPaths(imp.id);

    if (imp.pid !== null) {
      await context.vms.stopVm(imp.pid, paths, true);
    }

    await context.cgroups.remove(imp.id);

    removeSnapshot(paths);
    context.admission?.release(imp.id);

    return imp.state === 'stopped'
      ? imp
      : updateState(imp, { reason: 'stopped', state: 'stopped', pid: null });
  };

  // the last look before the pause, under the imp's lock; nothing attaches
  // in between, since an open exec or attach keeps an imp from sleeping
  const readSessionsForSleep = async (imp: LockedImp, paths: ImpPaths) => {
    const seen = await sendActivity(paths.vsockSocket).then(
      (activity) => activity.sessions,
      () => context.sessions.read(imp.id) ?? [],
    );

    return seen.map((session) => setDetached(session));
  };

  const sleepWithRoom = async (
    imp: LockedImp,
    paths: ImpPaths,
    pid: number,
    reason: string,
    waitedMs: number,
  ): Promise<LockedImp> => {
    const ramMib = context.readRamMib(pid, paths.apiSocket) ?? 0;

    const sessions = await readSessionsForSleep(imp, paths);

    const services = await sendServicesList(paths.vsockSocket, SERVICES_FOR_SLEEP_MS).catch(
      () => null,
    );

    const started = performance.now();

    // what the event stream reports about this sleep
    const slept: { detail: ImpEventDetail } = { detail: { trigger: reason } };

    removeSnapshotMeta(paths);

    try {
      const cgroup = context.cgroups.setup(imp.id, imp.cpu);

      const timings = await sleepSlots.run(() => context.vms.sleepVm(pid, paths, cgroup, paths));

      const booted = readVmIdentity(paths);

      writeSnapshotMeta(paths, {
        ...buildSnapshotIdentity(booted, context.identity),
        createdAt: Date.now(),
        memoryMib: imp.memoryMib,
        ramMib,
        sessions,
        ...(services !== null && { services }),
      });

      // its next wake restores this memory: the cold boot is news no longer
      if (booted !== null && booted.bootReason !== null) {
        writeIdentity(imp, paths, { ...booted, bootReason: null });
      }

      const sleepMs = Math.round(performance.now() - started);
      const waited = waitedMs > 0 ? `, waited ${String(waitedMs)}ms for a young guest` : '';

      slept.detail = { trigger: reason, durationMs: sleepMs, steps: timings };

      context.log(
        `impd: ${imp.name}: asleep in ${String(sleepMs)}ms (${reason})${waited}, ram ${String(ramMib)} MiB, mem file ${String(readDiskMib(paths.memFile))} MiB on disk, ${formatTimings(timings)}`,
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

      await updateState(imp, {
        reason: 'stopped',
        detail: { trigger: reason },
        state: 'stopped',
        pid: null,
      });

      throw error;
    }

    context.admission?.release(imp.id);

    return updateState(imp, {
      reason: 'slept',
      detail: slept.detail,
      state: 'sleeping',
      pid: null,
      sleptAt: new Date(),
    });
  };

  const sleepImpVm = async (
    imp: LockedImp,
    reason: string,
    youngGuest: YoungGuestWait = ALWAYS_WAIT,
  ): Promise<LockedImp> => {
    requireTransition(imp.state, 'sleeping', 'sleep');

    const paths = context.findPaths(imp.id);
    const pid = imp.pid;

    if (pid === null) {
      throw new Error(`${imp.name} is running without a firecracker pid`);
    }

    // the memory file is written in full before its holes are dug: first,
    // so no wait or pause starts unless the disk has room for it
    const slept = await context.diskBudget.withRoom(imp.memoryMib * 1024 * 1024, async () => {
      const waitedMs = youngGuest.wait
        ? await waitForGuestAge({
            readUptimeMs: () => context.vms.readGuestUptimeMs(paths),
            minUptimeMs: context.config.sleepMinGuestUptimeMs,
            isWanted: youngGuest.isWanted,
          })
        : 0;

      if (waitedMs === null) {
        context.log(`impd: ${imp.name}: sleep (${reason}) gave way: the imp turned busy`);

        return imp;
      }

      return sleepWithRoom(imp, paths, pid, reason, waitedMs);
    });

    return slept;
  };

  // resumes from the snapshot, or boots cold when there is none, it does not
  // match this host, or the load fails: the disk is always the truth
  const wakeImpVm = async (imp: LockedImp): Promise<LockedImp> => {
    gate.requireOpen();

    const paths = context.findPaths(imp.id);
    const meta = readSnapshotMeta(paths);

    const mismatch =
      meta === null ? 'no snapshot it can load' : findColdBootReason(meta, context.identity);

    if (meta === null || mismatch !== null) {
      context.log(
        `impd: ${imp.name}: cold boot instead of a wake: ${mismatch ?? 'no snapshot it can load'}`,
      );

      return startColdImpVm(imp, mismatch, true);
    }

    // a woken VM faults its pages back in; it grows toward what it owned
    await context.admission?.admit({
      id: imp.id,
      name: imp.name,
      reserveMib: Math.max(meta.ramMib, context.config.wakeReserveMib),
      memoryMib: imp.memoryMib,
    });

    const started = performance.now();

    setSnapshotLoading(paths);

    const woken = await loadSnapshot(imp, paths);

    if (woken instanceof Error) {
      return startAfterFailedWake(imp, paths, woken);
    }

    // the drive the snapshot reopened is the one the VM booted from, so its
    // agent answers as it did then; anything else is not that VM
    if (meta.agentVersion !== undefined && woken.agentVersion !== meta.agentVersion) {
      await stopWrongVm(imp, paths, woken.pid);

      const wrong = new Error(
        `the agent answered as ${woken.agentVersion}, not ${meta.agentVersion}`,
      );

      return startAfterFailedWake(imp, paths, wrong);
    }

    const wakeMs = Math.round(performance.now() - started);

    context.log(
      `impd: ${imp.name}: woke pid ${String(woken.pid)} in ${String(wakeMs)}ms ${formatTimings(woken.timings)}`,
    );

    startCounting(context, imp, woken.pid);

    await updateImpActivity(context.db, imp.id, new Date());

    const running = await updateState(imp, {
      reason: 'woke',
      detail: { durationMs: wakeMs, steps: woken.timings },
      state: 'running',
      pid: woken.pid,
      error: null,
      sleptAt: null,
      firecrackerVersion: woken.firecrackerVersion,
    });

    // after the record: impd dying before it leaves a sleeping imp with its
    // loading record, whose live VM the next reconcile adopts
    removeSnapshotMeta(paths);

    if (!running.isDiskGrowPending) {
      return running;
    }

    // the disk grew while it slept: a failed grow stays pending, the wake stands
    return growGuestDisk(running).catch(() => running);
  };

  const removeLockedIdentityReset = async (imp: LockedImp): Promise<LockedImp> => {
    const updated = await removeIdentityReset(context.db, imp.id);

    return toLockedImp(imp, updated);
  };

  const setGrowPending = async (imp: LockedImp, isGrowPending: boolean): Promise<LockedImp> => {
    const updated = await updateImpDisk(context.db, imp.id, {
      diskBytes: imp.diskBytes,
      isGrowPending,
    });

    return toLockedImp(imp, updated);
  };

  const growGuestDisk = async (imp: LockedImp): Promise<LockedImp> => {
    try {
      await context.vms.growDrive(context.findPaths(imp.id), imp.diskBytes);
    } catch (error) {
      const message = readErrorMessage(error);

      context.log(`impd: ${imp.name}: the guest did not grow into its disk: ${message}`);

      await setGrowPending(imp, true);

      if (error instanceof AgentError && error.code === 'AGENT_OUTDATED') {
        throw buildAgentOutdatedApiError(
          "the disk grew, but the imp's agent is too old to grow its filesystem while it runs; its next boot does (stop and start the imp)",
        );
      }

      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        message: `the disk grew, but the guest did not grow its filesystem (its next wake or boot does): ${message}`,
        cause: error,
      });
    }

    return imp.isDiskGrowPending ? setGrowPending(imp, false) : imp;
  };

  // the woken VM, or why the load or the agent failed; the VM is gone then
  const loadSnapshot = async (imp: LockedImp, paths: ImpPaths) => {
    try {
      // a container restart takes the taps with it
      await context.egress.requireImp(imp.id);
      await context.taps.setupTap(context.findAddress(imp.slot));

      return await context.vms.wakeVm({
        firecrackerBin: context.config.firecrackerBin,
        paths,
        cgroup: context.cgroups.setup(imp.id, imp.cpu),
      });
    } catch (error) {
      return error instanceof Error ? error : new Error(readErrorMessage(error));
    }
  };

  // A VM that will not stop still has the disk open: a cold boot now would put
  // two VMs on one disk. The error record keeps its pid, so a start or a
  // destroy kills it again, as reconcileImps does.
  const stopWrongVm = async (imp: LockedImp, paths: ImpPaths, pid: number): Promise<void> => {
    try {
      await context.vms.stopVm(pid, paths, false);
    } catch (error) {
      const message = readErrorMessage(error);

      context.log(`impd: ${imp.name}: could not stop the woken VM: ${message}`);
      context.admission?.release(imp.id);
      removeSnapshot(paths);

      await updateState(imp, {
        reason: 'failed',
        state: 'error',
        pid,
        error: `could not stop: ${message}`,
      });

      throw error;
    }
  };

  const startAfterFailedWake = async (
    imp: LockedImp,
    paths: ImpPaths,
    error: Readonly<Error>,
  ): Promise<LockedImp> => {
    const failure = error.message.split('\n')[0] ?? '';

    context.log(`impd: ${imp.name}: ${failure}; booting cold`);
    context.admission?.release(imp.id);

    // the load may have run the guest, which can write its disk: the
    // snapshot no longer matches it, even if the cold boot is turned away
    removeSnapshot(paths);

    const stopped = await updateState(imp, {
      reason: 'stopped',
      detail: { trigger: failure },
      state: 'stopped',
      pid: null,
    });

    return startColdImpVm(stopped, failure, true);
  };

  const requireRunningImp = async (imp: LockedImp): Promise<LockedImp> => {
    if (imp.state === 'running') {
      return imp;
    }

    // a wake goes through below the reserve, so a full disk never strands an
    // imp's work; a cold boot writes the disk from the start, and waits
    if (imp.state === 'sleeping') {
      return wakeImpVm(imp);
    }

    await context.diskBudget.requireRoom(0);

    requireTransition(imp.state, 'running', 'start');

    if (imp.pid !== null) {
      await context.vms.stopVm(imp.pid, context.findPaths(imp.id), false);
    }

    return startImpVm(imp);
  };

  const startFreshImpVm = async (imp: LockedImp, reason: string): Promise<LockedImp> => {
    if (imp.pid !== null) {
      await context.vms.stopVm(imp.pid, context.findPaths(imp.id), false);
    }

    context.admission?.release(imp.id);

    const stopped = await updateState(imp, {
      reason: 'stopped',
      detail: { trigger: reason },
      state: 'stopped',
      pid: null,
    });

    return startColdImpVm(stopped, reason);
  };

  return {
    updateState,
    writeFailure,
    startImpVm,
    stopImpVm,
    sleepImpVm,
    requireRunningImp,
    growGuestDisk,
    startFreshImpVm,
    withSleepSlot: sleepSlots.run,
  };
}

// allocated size: the mem file is sparse after --dig-holes
function readDiskMib(path: string): number {
  try {
    return Math.round((statSync(path).blocks * 512) / 1_048_576);
  } catch {
    return 0;
  }
}

function countStepsMs(timings: Readonly<Record<string, number>>): number {
  return Object.values(timings).reduce((total, ms) => total + ms, 0);
}

function formatTimings(timings: Readonly<Record<string, number>>): string {
  return Object.entries(timings)
    .map(([step, ms]) => `${step}=${String(ms)}ms`)
    .join(' ');
}

// a sleeping imp has no client attached: the sleep closed every connection
function setDetached(session: AgentSession): AgentSession {
  return { ...session, attached: false };
}
