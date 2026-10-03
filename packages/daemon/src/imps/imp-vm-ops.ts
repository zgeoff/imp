import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ColdBootCause, ImpEventDetail } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import { sendActivity } from '../agent-client/agent-requests';
import { sendServicesList } from '../agent-client/service-requests';
import { buildAgentOutdatedApiError } from '../api-errors';
import { removeNextBootCause, writeColdBoot, writeUnknownBoot } from '../db/cold-boots';
import { removeIdentityReset, updateImpActivity, updateImpDisk, updateImpState } from '../db/imps';
import type { ImpStateChange } from '../db/imps';
import { shrinkGuest } from '../memory/shrink-guest';
import type { SlotAddress } from '../net/addressing';
import { GATEWAY_IP6 } from '../net/addressing6';
import { readErrorMessage } from '../read-error-message';
import { toSeenSessions } from '../sessions/session-cache';
import type { SeenSession } from '../sessions/session-cache';
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
import type { ImpCgroup } from '../vmm/cpu-cgroups';
import { TemplateRestoreError } from '../vmm/template-vm';
import type { StartedVm } from '../vmm/vm-runner';
import { checkMergeFlag } from './check-merge-flag';
import type { ImpContext } from './imp-context';
import { toLockedImp } from './imp-lock';
import type { LockedImp } from './imp-lock';
import { requireTransition } from './imp-transitions';
import { OOM_KILL_TRIGGER, startOomWatch } from './oom-kill';
import { startCounting } from './read-running-imp-usage';
import { createSemaphore } from './semaphore';
import type { ShutdownGate } from './shutdown-gate';

// what a sleep waits under the imp's lock for an elastic guest to unplug
const SLEEP_SHRINK_LIMIT_MS = 2000;

// snapshot writes put the whole mem file through the page cache
// (docs/architecture/sleep-and-wake.md#4-gotchas, gotcha 8): a few at a time
const SLEEP_CONCURRENCY = 2;

// the claim's seed for the guest's entropy pool; the agent wants 32 or more
const CLAIM_SEED_BYTES = 64;

// how long a sleep waits for the services list it records
const SERVICES_FOR_SLEEP_MS = 1000;

// why a jailed VM does not start without its cgroup: cgroup.kill is what
// stops every process a guest escape forks, faster than any /proc scan
const NO_JAIL_CGROUP =
  'a jailed VM starts only in its own cgroup, and it has none: the cpu controller is not delegated to /sys/fs/cgroup/imps, or the setup of imps/<id> failed (see the log); set IMP_JAILER=false on a host without cgroup delegation';

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

  // boots the imp's disk; a memory snapshot is dropped first. `cause` is
  // what the boot records (docs/architecture/daemon.md#output-offsets).
  readonly startImpVm: (
    imp: LockedImp,
    cause: Extract<ColdBootCause, 'start' | 'restore'>,
  ) => Promise<LockedImp>;

  // a new imp's first boot while its disk is still being sized: a template
  // restore runs up to the parked guest meanwhile
  readonly startNewImpVm: (imp: LockedImp, diskReady: Promise<unknown>) => Promise<LockedImp>;

  // agent shutdown, then the memory goes too: a stopped imp boots cold. Not
  // `graceful`, it kills Firecracker at once: for a guest whose disk and
  // memory are thrown away next.
  readonly stopImpVm: (imp: LockedImp, graceful?: boolean) => Promise<LockedImp>;

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
  // the disk cold, the watchdog's restart; `reason` says why on the imp
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

  // the cgroup a VM starts in; a jailed VM refuses to start without one
  const setupVmCgroup = (imp: LockedImp): ImpCgroup | null => {
    const cgroup = context.cgroups.setup(imp.id, imp.cpu, imp.memoryMib);

    if (cgroup === null && context.findJailUser(imp) !== null) {
      throw new Error(NO_JAIL_CGROUP);
    }

    return cgroup;
  };

  // A cold boot: a restore of the shape's boot template when one is ready,
  // else the kernel's boot. A template that fails to restore goes, and the
  // imp boots the kernel (docs/architecture/boot-templates.md#restore).
  const startColdVm = async (
    imp: LockedImp,
    paths: ImpPaths,
    address: SlotAddress,
    hostSteps: Readonly<Record<string, number>>,
    diskReady: Promise<unknown>,
  ): Promise<StartedVm> => {
    // a fresh guest holds nothing plugged; the cgroup keeps a size from
    // before a sleep, which a wake that boots cold must not inherit
    context.memoryLimit.setGuestMib(imp.id, imp.memoryMib);

    const cgroup = setupVmCgroup(imp);

    // a template has no hot-plug region: an elastic imp boots the kernel
    // (docs/architecture/memory.md#limits)
    const template =
      imp.maxMemoryMib > imp.memoryMib
        ? null
        : context.templates?.find({ vcpus: imp.vcpus, memoryMib: imp.memoryMib });

    // a disk that fails is the create's failure, not the template's
    const disk = { isFailed: false };

    const readDiskBytes = async () => {
      try {
        await diskReady;
      } catch (error) {
        disk.isFailed = true;
        throw error;
      }

      return statSync(paths.disk).size;
    };

    const diskBytes = readDiskBytes();

    // handled now: a restore that fails first never awaits it
    void Promise.allSettled([diskBytes]);

    if (template !== null && template !== undefined) {
      try {
        const vm = await context.vms.loadTemplateVm({
          firecrackerBin: context.config.firecrackerBin,
          paths,
          vmstate: template.vmstate,
          memFile: template.memFile,
          systemDrivePath: template.systemDrivePath,
          placeholderPath: template.placeholderPath,
          jail: context.findJailUser(imp),
          diskPath: resolve(paths.disk),
          tap: address.tap,
          cgroup,
          diskReady: diskBytes,
          claim: {
            id: imp.id,
            hostname: imp.name,
            ip: `${address.guestIp}/${String(address.prefixLength)}`,
            gw: address.hostIp,
            ip6: address.guestIp6 === null ? null : `${address.guestIp6}/128`,
            gw6: address.guestIp6 === null ? null : GATEWAY_IP6,
            dns: context.config.dns,
            mac: address.guestMac,
            seed: randomBytes(CLAIM_SEED_BYTES),
            isIdentityReset: imp.isIdentityResetPending,
          },
        });

        context.templates?.reportRestored(template);

        context.log(
          `impd: ${imp.name}: restored boot template ${template.key.slice(0, 12)} as pid ${String(vm.pid)} ${formatTimings({ ...hostSteps, ...vm.timings })}`,
        );

        return vm;
      } catch (error) {
        if (disk.isFailed) {
          await diskBytes;
        }

        context.log(
          `impd: ${imp.name}: boot template ${template.key.slice(0, 12)} failed, booting the kernel: ${readErrorMessage(error)}`,
        );

        // a failure of the imp's own (its disk, its claim) leaves the template
        const isTemplateFault = error instanceof TemplateRestoreError && error.isTemplateFault;

        context.templates?.reportFailure(template, isTemplateFault);
      }
    }

    await diskBytes;

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
      maxMemoryMib: imp.maxMemoryMib,
      dns: context.config.dns,
      cgroup,
      isIdentityReset: imp.isIdentityResetPending,
      jail: context.findJailUser(imp),
    });

    context.log(
      `impd: ${imp.name}: booted pid ${String(vm.pid)} ${formatTimings({ ...hostSteps, ...vm.timings })}`,
    );

    return vm;
  };

  // `reason` says why a wake booted cold instead; null for a create or a start
  // `cause` is the typed reason the boot records; a wake_fallback counts as
  // the wake it stands in for
  const startColdImpVm = async (
    imp: LockedImp,
    cause: Exclude<ColdBootCause, 'recovery' | 'unknown'>,
    reason: string | null,
    diskReady: Promise<unknown> = Promise.resolve(),
  ): Promise<LockedImp> => {
    const isWake = cause === 'wake_fallback';

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
      memoryMib: imp.maxMemoryMib,
    });

    const setupStarted = performance.now();

    try {
      // a memory snapshot is only valid with the disk it was taken with. It
      // goes once the boot is admitted: a sleeping imp the budget turns away
      // keeps its memory.
      removeSnapshot(paths);

      // a box or none imp never runs where nft cannot hold it in
      await context.egress.requireImp(imp.id);
      await context.taps.setupTap(address, context.findJailUser(imp));

      // the host's part before the VM, for the boot's log line
      const hostSteps = {
        admit: Math.round(setupStarted - admitStarted),
        setup: Math.round(performance.now() - setupStarted),
      };

      const vm = await startColdVm(imp, paths, address, hostSteps, diskReady);

      startCounting(context, imp, vm.pid);

      await checkMergeFlag(context, imp, vm.pid);

      // its sleeps record this, whatever the host boots by then
      writeIdentity(imp, paths, {
        ...context.identity,
        agentVersion: vm.agentVersion,
        bootReason: reason,
      });

      await updateImpActivity(context.db, imp.id, new Date());

      // an agent from before output offsets has no boot_id; its sessions
      // have no generations for a boot to end
      await (vm.bootId === undefined
        ? removeNextBootCause(context.db, imp.id)
        : writeColdBoot(context.db, imp.id, { bootId: vm.bootId, cause, at: new Date() }));

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

      // the agent grew the filesystem to fill the disk
      return reset.isDiskGrowPending ? await setGrowPending(reset, false) : reset;
    } catch (error) {
      context.admission?.release(imp.id);

      await writeFailure(imp, error);

      throw error;
    }
  };

  const startImpVm: ImpVmOps['startImpVm'] = (imp, cause) => startColdImpVm(imp, cause, null);

  const startNewImpVm = (imp: LockedImp, diskReady: Promise<unknown>): Promise<LockedImp> =>
    startColdImpVm(imp, 'start', null, diskReady);

  const stopImpVm = async (imp: LockedImp, graceful = true): Promise<LockedImp> => {
    const paths = context.findPaths(imp.id);

    if (imp.pid !== null) {
      await context.vms.stopVm(imp.pid, paths, graceful);
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
      (activity) => toSeenSessions(activity.sessions, new Date()),
      () => context.sessions.read(imp.id) ?? [],
    );

    return seen.map((session) => setDetached(session));
  };

  // An elastic guest gives back what it can spare before the pause, so the
  // snapshot writes less (docs/architecture/memory.md#sleep); returns what it
  // keeps plugged, null for an imp that does not grow.
  const shrinkForSleep = async (imp: LockedImp, paths: ImpPaths): Promise<number | null> => {
    if (imp.maxMemoryMib <= imp.memoryMib) {
      return null;
    }

    try {
      const pluggedMib = await shrinkGuest(context.vms, paths, {
        timeLimitMs: SLEEP_SHRINK_LIMIT_MS,
      });

      context.pluggedSizes.write(imp.id, pluggedMib);

      return pluggedMib;
    } catch (error) {
      context.log(`impd: ${imp.name}: no shrink before the sleep: ${readErrorMessage(error)}`);

      return readPluggedMib(imp, paths);
    }
  };

  // what the guest holds, or will once a plug under way ends, or the most it
  // can when even that fails: the disk room and the wake's limit cover it
  const readPluggedMib = async (imp: LockedImp, paths: ImpPaths): Promise<number> => {
    if (imp.maxMemoryMib <= imp.memoryMib) {
      return 0;
    }

    try {
      const memory = await context.vms.readGuestMemory(paths);

      return Math.max(memory.pluggedMib, memory.requestedMib);
    } catch {
      return imp.maxMemoryMib - imp.memoryMib;
    }
  };

  const sleepWithRoom = async (
    imp: LockedImp,
    paths: ImpPaths,
    pid: number,
    reason: string,
    waitedMs: number,
    requestedAt: number,
  ): Promise<LockedImp> => {
    const pluggedMib = await shrinkForSleep(imp, paths);

    const ramMib = context.readSleepRamMib(pid, paths.apiSocket) ?? 0;

    const sessions = await readSessionsForSleep(imp, paths);

    const services = await sendServicesList(paths.vsockSocket, SERVICES_FOR_SLEEP_MS).catch(
      () => null,
    );

    const started = performance.now();

    // what the event stream reports about this sleep
    const slept: { detail: ImpEventDetail } = { detail: { trigger: reason } };

    removeSnapshotMeta(paths);

    const hasOomKill = startOomWatch(context.cgroups, imp.id);

    try {
      const cgroup = context.cgroups.setup(imp.id, imp.cpu, imp.memoryMib);

      const timings = await sleepSlots.run(() => context.vms.sleepVm(pid, paths, cgroup, paths));

      const booted = readVmIdentity(paths);

      writeSnapshotMeta(paths, {
        ...buildSnapshotIdentity(booted, context.identity),
        createdAt: Date.now(),
        memoryMib: imp.memoryMib,
        ramMib,
        ...(pluggedMib !== null && pluggedMib > 0 && { pluggedMib }),
        sessions,
        ...(services !== null && { services }),
      });

      // its next wake restores this memory: the cold boot is news no longer
      if (booted !== null && booted.bootReason !== null) {
        writeIdentity(imp, paths, { ...booted, bootReason: null });
      }

      const sleepMs = Math.round(performance.now() - started);
      const waited = waitedMs > 0 ? `, waited ${String(waitedMs)}ms for a young guest` : '';

      slept.detail = {
        trigger: reason,
        durationMs: sleepMs,
        prepareMs: Math.round(started - requestedAt),
        steps: timings,
      };

      const plugged = pluggedMib === null ? '' : `, ${String(pluggedMib)} MiB plugged`;

      context.log(
        `impd: ${imp.name}: asleep in ${String(sleepMs)}ms (${reason})${waited}, ram ${String(ramMib)} MiB${plugged}, mem file ${String(readDiskMib(paths.memFile))} MiB on disk, ${formatTimings(timings)}`,
      );
    } catch (error) {
      if (context.vms.isVmAlive(pid, paths)) {
        throw error;
      }

      // a snapshot's page cache counts against the memory limit
      const isOomKill = hasOomKill();
      const message = readErrorMessage(error);
      const failure = isOomKill ? `${OOM_KILL_TRIGGER} (${message})` : message;

      context.log(`impd: ${imp.name}: sleep failed after firecracker stopped: ${failure}`);

      removeSnapshot(paths);
      context.admission?.release(imp.id);

      await updateState(imp, {
        reason: 'stopped',
        detail: { trigger: isOomKill ? OOM_KILL_TRIGGER : reason },
        state: 'stopped',
        pid: null,
        ...(isOomKill && { error: OOM_KILL_TRIGGER }),
      });

      throw isOomKill ? new Error(`sleep failed: ${OOM_KILL_TRIGGER}`, { cause: error }) : error;
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

    // the slept event's prepareMs counts from here
    const requestedAt = performance.now();
    const paths = context.findPaths(imp.id);
    const pid = imp.pid;

    if (pid === null) {
      throw new Error(`${imp.name} is running without a firecracker pid`);
    }

    // the memory file is written in full before its holes are dug: first,
    // so no wait or pause starts unless the disk has room for it. The shrink
    // before the pause only lowers an elastic guest's plugged size.
    const memFileMib = imp.memoryMib + (await readPluggedMib(imp, paths));

    const slept = await context.diskBudget.withRoom(memFileMib * 1024 * 1024, async () => {
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

      return sleepWithRoom(imp, paths, pid, reason, waitedMs, requestedAt);
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

      return startColdImpVm(imp, 'wake_fallback', mismatch);
    }

    // before the load and the admission: a wake that cannot start keeps the
    // imp asleep, with its snapshot
    const cgroup = setupVmCgroup(imp);

    // a woken VM faults its pages back in; it grows toward what it owned
    await context.admission?.admit({
      id: imp.id,
      name: imp.name,
      reserveMib: Math.max(meta.ramMib, context.config.wakeReserveMib),
      memoryMib: imp.maxMemoryMib,
    });

    // the load restores what the guest held plugged: the host allows it first
    context.memoryLimit.setGuestMib(imp.id, imp.memoryMib + (meta.pluggedMib ?? 0));

    if (meta.pluggedMib !== undefined) {
      context.pluggedSizes.write(imp.id, meta.pluggedMib);
    }

    const started = performance.now();

    setSnapshotLoading(paths);

    const woken = await loadSnapshot(imp, paths, cgroup);

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

    await checkMergeFlag(context, imp, woken.pid);
    await updateImpActivity(context.db, imp.id, new Date());

    // a memory wake keeps the boot; one that slept before impd kept cold
    // boots has no row for it yet
    if (woken.bootId !== undefined) {
      await writeUnknownBoot(context.db, imp.id, woken.bootId, new Date());
    }

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
  const loadSnapshot = async (imp: LockedImp, paths: ImpPaths, cgroup: ImpCgroup | null) => {
    const hasOomKill = startOomWatch(context.cgroups, imp.id);

    try {
      // a container restart takes the taps with it
      await context.egress.requireImp(imp.id);
      await context.taps.setupTap(context.findAddress(imp.slot), context.findJailUser(imp));

      return await context.vms.wakeVm({
        firecrackerBin: context.config.firecrackerBin,
        paths,
        cgroup,
        jail: context.findJailUser(imp),
        readOnlyFiles: [context.identity.systemDrivePath],
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(readErrorMessage(error));

      // the first line is the failure the record keeps: the limit, not the API error
      return hasOomKill()
        ? new Error(`wake failed: ${OOM_KILL_TRIGGER}\n${failure.message}`, { cause: failure })
        : failure;
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

    return startColdImpVm(stopped, 'wake_fallback', failure);
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

    return startImpVm(imp, 'start');
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

    return startColdImpVm(stopped, 'watchdog', reason);
  };

  return {
    updateState,
    writeFailure,
    startImpVm,
    startNewImpVm,
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
function setDetached(session: SeenSession): SeenSession {
  return { ...session, attached: false };
}
