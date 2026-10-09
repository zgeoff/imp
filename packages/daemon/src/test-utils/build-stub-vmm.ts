import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { buildAgentOutdatedError } from '../agent-client/agent-outdated';
import type { ImpPaths } from '../storage/data-layout';
import type { InstanceState } from '../vmm/firecracker-client';
import type { FirecrackerPaths, VmOwner } from '../vmm/firecracker-process';
import type { JailUser } from '../vmm/jail';
import { TemplateRestoreError } from '../vmm/template-vm';
import type { TemplateRestorePlan } from '../vmm/template-vm';
import type { VmRunner } from '../vmm/vm-runner';

// what every fake agent's ping reports
export const STUB_AGENT_VERSION = '0.1.0';

// whom every VM runs as unless a test says otherwise: impd's own uid, as an
// unjailed Firecracker does
const IMPD_OWNER: VmOwner = { uid: process.getuid?.() ?? 0, cgroup: null };

export type VmStep =
  | 'boot'
  | 'wake'
  | 'sleep'
  | 'stop'
  | 'agentReady'
  | 'grow'
  | 'vmState'
  | 'template'
  | 'restore'
  | 'claim';

// What the next call of a step does, within the VmRunner contract; each step
// below says what fail and die mean for it. A hang waits for releaseHangs(),
// then succeeds.
export type VmOutcome = 'ok' | 'fail' | 'die' | 'hang';

// Every failure the fake makes, so a test can tell it from a real bug.
export class StubVmError extends Error {
  constructor(message: string) {
    super(message);

    this.name = 'StubVmError';
  }
}

interface Hold {
  // resolves when the first call reaches the hold
  readonly reached: Promise<void>;
  readonly release: () => void;
}

// a boot_id as the kernel writes one, a UUID, here made from the VM's pid
export function buildStubBootId(pid: number): string {
  return `00000000-0000-4000-8000-${String(pid).padStart(12, '0')}`;
}

// One fake host for every impd the test starts. Firecrackers outlive impd, so
// `alive` is shared; each impd gets its own runner, and a runner whose impd
// was replaced never settles a call again, like a process that is gone.
export function buildStubVmm() {
  const alive = new Set<number>();

  // the version each boot and wake reports; a test may set it
  const agent = { version: STUB_AGENT_VERSION };

  // what each VM serves and does, and the pid files starts wrote; only a pid
  // in `alive` counts
  const vms = new Map<number, { apiSocket: string; state: InstanceState; owner: VmOwner }>();
  const pidFiles = new Map<string, number>();

  const wakes: number[] = [];

  // the boot_id each API socket's guest booted with; a wake keeps it
  const bootIds = new Map<string, string>();

  const stops: { pid: number; graceful: boolean }[] = [];
  const grows: { disk: string; diskBytes: number }[] = [];

  // each cold boot's hostname and whether it asked for an identity reset
  const boots: { hostname: string; isIdentityReset: boolean }[] = [];

  // each template build's shape, and each restore's claim
  const templateBuilds: { vcpus: number; memoryMib: number }[] = [];
  const restores: { hostname: string; isIdentityReset: boolean; memFile: string }[] = [];

  // the startup sweeps of orphans in their order; a test's cgroups add theirs
  const sweeps: string[] = [];

  // every restore's whole plan: what its jail binds and who it runs as
  const restorePlans: TemplateRestorePlan[] = [];

  // each wake's jail user, and which of the files its jail prepare hands the
  // VM were there when it began
  const wakeJails: { jail: JailUser | null; files: string[] }[] = [];

  // snapshot dirs a wake loaded: the guest ran on them, so they no longer
  // match the disk, even when the wake then failed
  const usedSnapshots = new Set<string>();

  const counter = { nextPid: 1000, generation: 0 };

  // what every fake agent reports as its uptime: old enough to sleep at once
  // hasBootId false: a guest whose agent could not read its boot_id
  const guest = {
    uptimeMs: 60_000,
    identityReset: 'ok' as 'ok' | 'failed' | undefined,
    hasBootId: true,
  };

  // elastic guests by imp dir: what each holds, and how far down it can
  // unplug (in use memory it cannot migrate away)
  const guestMemory = new Map<string, FakeGuestMemory>();

  // a guest no test set up: 512 MiB, nothing plugged
  const readFakeGuestMemory = (dir: string): FakeGuestMemory => {
    const known = guestMemory.get(dir);

    if (known !== undefined) {
      return known;
    }

    const created = {
      baseMib: 512,
      pluggedMib: 0,
      requestedMib: 0,
      usedMib: 100,
      unplugFloorMib: 0,
    };

    guestMemory.set(dir, created);

    return created;
  };

  const queues = new Map<VmStep, VmOutcome[]>();
  const holds = new Map<VmStep, { gate: PromiseWithResolvers<void>; reached: () => void }>();

  const hangs = { gate: Promise.withResolvers<void>() };

  // calls waiting on a hang now, and calls of replaced runners that never
  // settle: what a test waits for before it reads a call as pending
  const waiting = { hung: 0, parked: 0 };

  // runs between the steps of every call; a property test hands it to its
  // scheduler to order the steps of concurrent calls
  const pacer: { pace: (step: VmStep) => Promise<void> } = { pace: () => Promise.resolve() };

  const pickOutcome = async (step: VmStep): Promise<Exclude<VmOutcome, 'hang'>> => {
    const hold = holds.get(step);

    if (hold !== undefined) {
      hold.reached();

      await hold.gate.promise;
    }

    await pacer.pace(step);

    const outcome = queues.get(step)?.shift() ?? 'ok';

    if (outcome !== 'hang') {
      return outcome;
    }

    waiting.hung += 1;

    await hangs.gate.promise;

    waiting.hung -= 1;

    return 'ok';
  };

  const startPid = (): number => {
    counter.nextPid += 1;

    return counter.nextPid;
  };

  const setVm = (
    pid: number,
    paths: Readonly<FirecrackerPaths>,
    state: InstanceState,
    owner: VmOwner = IMPD_OWNER,
  ): void => {
    alive.add(pid);
    vms.set(pid, { apiSocket: paths.apiSocket, state, owner });
  };

  // the newest live VM on the socket: the one its API answers from
  const findServing = (paths: Readonly<ImpPaths>) => {
    const serving = [...vms].filter(
      ([pid, vm]) => alive.has(pid) && vm.apiSocket === paths.apiSocket,
    );

    return serving.at(-1)?.[1];
  };

  const buildRunner = (generation: number): VmRunner => {
    // a replaced impd: every later call waits forever
    const waitForever = <T>(): Promise<T> => {
      waiting.parked += 1;

      return new Promise<T>(() => {});
    };

    // an in-flight call whose impd was replaced parks whether it resolves or
    // rejects, so a dead impd makes no late write
    const runInGeneration = async <T>(call: () => Promise<T>): Promise<T> => {
      if (generation !== counter.generation) {
        return waitForever();
      }

      const settled = await call().then(
        (value) => ({ isOk: true as const, value }),
        (error: unknown) => ({ isOk: false as const, error }),
      );

      if (generation !== counter.generation) {
        return waitForever();
      }

      if (!settled.isOk) {
        throw settled.error;
      }

      return settled.value;
    };

    // a synchronous read by a replaced impd throws instead of answering
    const readInGeneration = <T>(read: () => T): T => {
      if (generation !== counter.generation) {
        throw new Error('this impd was replaced');
      }

      return read();
    };

    // fail leaves no VM; die returns a pid whose VM is already gone
    const startFakeVm = async (
      step: 'boot' | 'wake' | 'restore',
      paths: Readonly<FirecrackerPaths>,
    ) => {
      const outcome = await pickOutcome(step);

      if (outcome === 'fail') {
        throw new StubVmError(`${step} failed: no agent\nlog tail`);
      }

      const pid = startPid();

      pidFiles.set(paths.pidFile, pid);

      if (outcome === 'ok') {
        setVm(pid, paths, 'Running');
      }

      return { pid, firecrackerVersion: 'v1.17.0', agentVersion: agent.version, timings: {} };
    };

    return {
      startVm: (plan) =>
        runInGeneration(async () => {
          boots.push({ hostname: plan.hostname, isIdentityReset: plan.isIdentityReset });

          const started = await startFakeVm('boot', plan.paths);

          // each cold boot is a new guest kernel, with its own boot_id
          const bootId = guest.hasBootId ? buildStubBootId(started.pid) : undefined;
          const vm = { ...started, bootId };

          if (bootId !== undefined) {
            bootIds.set(plan.paths.apiSocket, bootId);
          }

          return plan.isIdentityReset ? { ...vm, identityReset: guest.identityReset } : vm;
        }),
      wakeVm: (plan) =>
        runInGeneration(async () => {
          const files = [plan.paths.disk, plan.paths.vmstate, plan.paths.memFile];

          wakeJails.push({ jail: plan.jail, files: files.filter((file) => existsSync(file)) });

          try {
            const vm = await startFakeVm('wake', plan.paths);

            wakes.push(vm.pid);

            return { ...vm, bootId: bootIds.get(plan.paths.apiSocket) };
          } finally {
            usedSnapshots.add(plan.paths.snapshotDir);
          }
        }),
      sleepVm: (pid, _paths, _cgroup, target) =>
        runInGeneration(async () => {
          const vm = vms.get(pid);

          // paused for the snapshot, as Firecracker is
          if (vm !== undefined) {
            vm.state = 'Paused';
          }

          // fail resumes the VM; die fails after the kill, with no snapshot
          const outcome = await pickOutcome('sleep');

          if (outcome === 'fail') {
            if (vm !== undefined) {
              vm.state = 'Running';
            }

            throw new StubVmError('snapshot failed');
          }

          alive.delete(pid);

          if (outcome === 'die') {
            throw new StubVmError('snapshot files lost after the kill');
          }

          // as Firecracker does: new files, renamed over the old ones
          mkdirSync(target.snapshotDir, { recursive: true });
          writeFileSync(`${target.vmstate}.new`, 'vmstate');
          writeFileSync(`${target.memFile}.new`, 'mem');
          renameSync(`${target.vmstate}.new`, target.vmstate);
          renameSync(`${target.memFile}.new`, target.memFile);

          usedSnapshots.delete(target.snapshotDir);

          return {};
        }),
      releaseVm: () => runInGeneration(() => Promise.resolve()),
      removeJail: () => runInGeneration(() => Promise.resolve()),
      removeOrphanJails: () =>
        runInGeneration(() => {
          sweeps.push('jails');

          return Promise.resolve([]);
        }),
      stopVm: (pid, _paths, graceful) =>
        runInGeneration(async () => {
          // fail and die: the VM survived SIGKILL
          const outcome = await pickOutcome('stop');

          if (outcome !== 'ok' && alive.has(pid)) {
            throw new StubVmError(`firecracker ${String(pid)} survived SIGKILL`);
          }

          alive.delete(pid);
          stops.push({ pid, graceful });
        }),
      isVmAlive: (pid) => readInGeneration(() => alive.has(pid)),

      // fail: the guest did not grow; die: its agent is from before grow
      growDrive: (paths, diskBytes) =>
        runInGeneration(async () => {
          const outcome = await pickOutcome('grow');

          if (outcome === 'die') {
            throw buildAgentOutdatedError('grow');
          }

          if (outcome !== 'ok') {
            throw new StubVmError('grow failed');
          }

          grows.push({ disk: paths.disk, diskBytes });
        }),
      isAgentReady: () =>
        runInGeneration(async () => {
          const outcome = await pickOutcome('agentReady');

          return outcome === 'ok';
        }),
      readGuestUptimeMs: () => runInGeneration(() => Promise.resolve(guest.uptimeMs)),

      // fail: the API does not answer, as while a large load runs
      readVmState: (paths) =>
        runInGeneration(async () => {
          const outcome = await pickOutcome('vmState');

          return outcome === 'ok' ? (findServing(paths)?.state ?? null) : null;
        }),
      resumeVm: (_pid, paths) =>
        runInGeneration(() => {
          const vm = findServing(paths);

          if (vm !== undefined) {
            vm.state = 'Running';
          }

          return Promise.resolve();
        }),
      readPid: (paths) => readInGeneration(() => pidFiles.get(paths.pidFile) ?? null),
      listVms: () =>
        readInGeneration(() =>
          [...vms]
            .filter(([pid]) => alive.has(pid))
            .map(([pid, vm]) => ({ pid, apiSocket: vm.apiSocket, owner: vm.owner })),
        ),
      readVmOwner: (pid) => readInGeneration(() => vms.get(pid)?.owner ?? IMPD_OWNER),
      finishWake: (paths) =>
        runInGeneration(async () => {
          const outcome = await pickOutcome('agentReady');

          if (outcome !== 'ok') {
            throw new StubVmError('the agent did not answer after the load');
          }

          return {
            agentVersion: agent.version,
            firecrackerVersion: 'v1.17.0',
            bootId: bootIds.get(paths.apiSocket),
          };
        }),

      // fail and die: no snapshot
      buildTemplateVm: (plan) =>
        runInGeneration(async () => {
          const outcome = await pickOutcome('template');

          if (outcome !== 'ok') {
            throw new StubVmError('template build failed');
          }

          mkdirSync(plan.snapshotDir, { recursive: true });
          writeFileSync(plan.vmstate, 'vmstate');
          writeFileSync(plan.memFile, 'mem');

          templateBuilds.push({ vcpus: plan.vcpus, memoryMib: plan.memoryMib });
        }),

      // restore: as a boot, a failure in the template's own steps; claim:
      // fail is a failure once the imp's disk and values are in play
      loadTemplateVm: (plan) =>
        runInGeneration(async () => {
          restorePlans.push(plan);

          const vm = await startFakeVm('restore', plan.paths).catch((error: unknown) => {
            throw new TemplateRestoreError('restore failed', true, error);
          });

          // as the real restore: the disk before the claim, and a disk that
          // fails is the imp's fault and ends the VM
          await plan.diskReady.catch((error: unknown) => {
            alive.delete(vm.pid);
            throw new TemplateRestoreError('disk failed', false, error);
          });

          if ((await pickOutcome('claim')) !== 'ok') {
            alive.delete(vm.pid);
            throw new TemplateRestoreError('claim failed', false, null);
          }

          restores.push({
            hostname: plan.claim.hostname,
            isIdentityReset: plan.claim.isIdentityReset,
            memFile: plan.memFile,
          });

          return plan.claim.isIdentityReset ? { ...vm, identityReset: guest.identityReset } : vm;
        }),
      readGuestMemory: (paths) =>
        runInGeneration(() => {
          const memory = readFakeGuestMemory(paths.dir);

          return Promise.resolve({
            pluggedMib: memory.pluggedMib,
            requestedMib: memory.requestedMib,
            totalMib: memory.baseMib + memory.pluggedMib,
            availableMib: memory.baseMib + memory.pluggedMib - memory.usedMib,
          });
        }),
      requestPluggedMib: (paths, mib) =>
        runInGeneration(() => {
          const memory = readFakeGuestMemory(paths.dir);

          memory.requestedMib = mib;
          memory.pluggedMib = Math.max(mib, Math.min(memory.pluggedMib, memory.unplugFloorMib));

          return Promise.resolve();
        }),
    };
  };

  return {
    alive,
    agent,
    usedSnapshots,
    wakes,
    stops,
    grows,
    boots,
    templateBuilds,
    restores,
    restorePlans,
    wakeJails,
    sweeps,

    // elastic guests by imp dir; a test sets what one uses and how far down
    // an unplug can go
    guestMemory,

    // the runner for a new impd; the one before it goes quiet
    startGeneration: (): VmRunner => {
      counter.generation += 1;

      return buildRunner(counter.generation);
    },

    // the next calls of `step` take these outcomes in order, then succeed
    queue: (step: VmStep, ...outcomes: readonly VmOutcome[]) => {
      queues.set(step, [...(queues.get(step) ?? []), ...outcomes]);
    },

    // every later call succeeds
    clearQueues: () => {
      queues.clear();
    },

    // every call of `step` waits until release()
    hold: (step: VmStep): Hold => {
      const reached = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();

      holds.set(step, { gate, reached: reached.resolve });

      return {
        reached: reached.promise,
        release: () => {
          holds.delete(step);
          gate.resolve();
        },
      };
    },

    countHungCalls: (): number => waiting.hung,
    countParkedCalls: (): number => waiting.parked,

    releaseHangs: () => {
      hangs.gate.resolve();

      hangs.gate = Promise.withResolvers<void>();
    },

    // the uptime every agent reports from now on
    setGuestUptime: (uptimeMs: number) => {
      guest.uptimeMs = uptimeMs;
    },

    // whether the guests booted from now on report a boot_id
    setGuestBootId: (hasBootId: boolean) => {
      guest.hasBootId = hasBootId;
    },

    // what every later boot that asks for an identity reset reports;
    // undefined is an agent that leaves the field out
    setIdentityReset: (result: 'ok' | 'failed' | undefined) => {
      guest.identityReset = result;
    },

    setPace: (pace: (step: VmStep) => Promise<void>) => {
      pacer.pace = pace;
    },

    // a Firecracker that is running without any impd knowing it yet; given
    // the imp's paths, it serves its socket in `state`, as `owner`, with a
    // pid file unless the start died before it wrote one
    spawnOrphan: (
      orphan: {
        readonly paths: Readonly<ImpPaths>;
        readonly state?: InstanceState;
        readonly pidFile?: boolean;
        readonly owner?: VmOwner;
      } | null = null,
    ): number => {
      const pid = startPid();

      alive.add(pid);

      if (orphan !== null) {
        setVm(pid, orphan.paths, orphan.state ?? 'Running', orphan.owner);

        if (orphan.pidFile ?? true) {
          pidFiles.set(orphan.paths.pidFile, pid);
        }
      }

      return pid;
    },

    // whom the VM `pid` runs as from now on, as a recycled pid would
    setOwner: (pid: number, owner: VmOwner) => {
      const vm = vms.get(pid);

      if (vm !== undefined) {
        vm.owner = owner;
      }
    },

    // what the VM `pid` does now, as GET / reports it
    readState: (pid: number): InstanceState | undefined => vms.get(pid)?.state,
  };
}

interface FakeGuestMemory {
  baseMib: number;
  pluggedMib: number;
  requestedMib: number;
  usedMib: number;

  // an unplug stops here, as a guest stops at memory it cannot migrate
  unplugFloorMib: number;
}
