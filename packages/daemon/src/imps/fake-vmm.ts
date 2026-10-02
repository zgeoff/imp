import { mkdirSync, writeFileSync } from 'node:fs';
import type { VmRunner } from '../vmm/vm-runner';

export type VmStep = 'boot' | 'wake' | 'sleep' | 'stop' | 'agentReady';

// What the next call of a step does, within the VmRunner contract; each step
// below says what fail and die mean for it. A hang waits for releaseHangs(),
// then succeeds.
export type VmOutcome = 'ok' | 'fail' | 'die' | 'hang';

interface Hold {
  // resolves when the first call reaches the hold
  readonly reached: Promise<void>;
  readonly release: () => void;
}

// One fake host for every impd the test starts. Firecrackers outlive impd, so
// `alive` is shared; each impd gets its own runner, and a runner whose impd
// was replaced never settles a call again, like a process that is gone.
export function buildFakeVmm() {
  const alive = new Set<number>();

  const wakes: number[] = [];
  const stops: { pid: number; graceful: boolean }[] = [];
  const counter = { nextPid: 1000, generation: 0 };

  const queues = new Map<VmStep, VmOutcome[]>();
  const holds = new Map<VmStep, { gate: PromiseWithResolvers<void>; reached: () => void }>();

  const hangs = { gate: Promise.withResolvers<void>() };

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

    await hangs.gate.promise;

    return 'ok';
  };

  const startPid = (): number => {
    counter.nextPid += 1;

    return counter.nextPid;
  };

  const buildRunner = (generation: number): VmRunner => {
    // a replaced impd: every later call waits forever
    const runInGeneration = async <T>(call: () => Promise<T>): Promise<T> => {
      if (generation !== counter.generation) {
        return new Promise<T>(() => {});
      }

      const result = await call();

      return generation === counter.generation ? result : new Promise<T>(() => {});
    };

    // fail leaves no VM; die returns a pid whose VM is already gone
    const startFakeVm = async (step: 'boot' | 'wake') => {
      const outcome = await pickOutcome(step);

      if (outcome === 'fail') {
        throw new Error(`${step} failed: no agent\nlog tail`);
      }

      const pid = startPid();

      if (outcome === 'ok') {
        alive.add(pid);
      }

      return { pid, firecrackerVersion: 'v1.17.0', timings: {} };
    };

    return {
      startVm: () => runInGeneration(() => startFakeVm('boot')),
      wakeVm: () =>
        runInGeneration(async () => {
          const vm = await startFakeVm('wake');

          wakes.push(vm.pid);

          return vm;
        }),
      sleepVm: (pid, paths) =>
        runInGeneration(async () => {
          // fail keeps the VM running; die fails after the kill, with no snapshot
          const outcome = await pickOutcome('sleep');

          if (outcome === 'fail') {
            throw new Error('snapshot failed');
          }

          alive.delete(pid);

          if (outcome === 'die') {
            throw new Error('snapshot files lost after the kill');
          }

          mkdirSync(paths.snapshotDir, { recursive: true });
          writeFileSync(paths.vmstate, 'vmstate');
          writeFileSync(paths.memFile, 'mem');

          return {};
        }),
      stopVm: (pid, _paths, graceful) =>
        runInGeneration(async () => {
          // fail and die: the VM survived SIGKILL
          const outcome = await pickOutcome('stop');

          if (outcome !== 'ok' && alive.has(pid)) {
            throw new Error(`firecracker ${String(pid)} survived SIGKILL`);
          }

          alive.delete(pid);
          stops.push({ pid, graceful });
        }),
      isVmAlive: (pid) => {
        if (generation !== counter.generation) {
          throw new Error('this impd was replaced');
        }

        return alive.has(pid);
      },
      isAgentReady: () =>
        runInGeneration(async () => {
          const outcome = await pickOutcome('agentReady');

          return outcome === 'ok';
        }),
    };
  };

  return {
    alive,
    wakes,
    stops,

    // the runner for a new impd; the one before it goes quiet
    startGeneration: (): VmRunner => {
      counter.generation += 1;

      return buildRunner(counter.generation);
    },

    // the next calls of `step` take these outcomes in order, then succeed
    queue: (step: VmStep, ...outcomes: readonly VmOutcome[]) => {
      queues.set(step, [...(queues.get(step) ?? []), ...outcomes]);
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

    releaseHangs: () => {
      hangs.gate.resolve();

      hangs.gate = Promise.withResolvers<void>();
    },

    setPace: (pace: (step: VmStep) => Promise<void>) => {
      pacer.pace = pace;
    },

    // a Firecracker that is running without any impd knowing it yet
    spawnOrphan: (): number => {
      const pid = startPid();

      alive.add(pid);

      return pid;
    },
  };
}
