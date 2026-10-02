import type { GuestNetBytes } from '../net/tap-bytes';
import type { CpuStat } from '../vmm/cpu-cgroups';

// USER_HZ: /proc/<pid>/stat counts CPU time in hundredths of a second
const USEC_PER_TICK = 10_000;

// one look at a running VM, as the API shows it; the counters run from
// `since`, when the sampler first saw this Firecracker
interface ResourceSample {
  readonly measuredAt: Date;
  readonly since: Date;
  readonly cpuPercent?: number;
  readonly cpuThrottledMs: number;
  readonly netRxBytes: number;
  readonly netTxBytes: number;
  readonly ramMib: number | null;
  readonly rssMib: number | null;
}

// what one imp used since the sampler's last look, for the metrics
export interface ResourceDelta {
  readonly intervalMs: number;
  readonly cpuPercent: number;
  readonly cpuUsec: number;
  readonly throttledUsec: number;
  readonly netRxBytes: number;
  readonly netTxBytes: number;
}

interface VmMemory {
  readonly ramMib: number | null;
  readonly rssMib: number | null;
}

interface SampledVm {
  readonly impId: string;
  readonly pid: number;
  readonly apiSocket: string;
  readonly tap: string;
}

interface SamplerReaders {
  readonly now: () => number;

  // the cgroup's counters; null without one, and then the pid's own ticks
  readonly readCpuStat: (impId: string) => CpuStat | null;
  readonly readCpuTicks: (pid: number) => number | null;
  readonly readNetBytes: (tap: string) => GuestNetBytes | null;

  // one read of smaps_rollup for both
  readonly readMemory: (pid: number, apiSocket: string) => VmMemory;
}

interface Counters {
  readonly cpuUsec: number;
  readonly throttledUsec: number;
  readonly rx: number;
  readonly tx: number;
}

interface Tracked {
  readonly pid: number;
  readonly since: number;
  readonly last: Counters;
  readonly lastAt: number;
  readonly totals: Counters;
  readonly sample: ResourceSample;
}

const ZERO: Counters = { cpuUsec: 0, throttledUsec: 0, rx: 0, tx: 0 };

// The latest sample of each running VM, keyed by imp id. A counter that drops
// (a new cgroup, a new tap) counts as reset: its whole value is new.
export interface ResourceSampler {
  // samples one VM; the delta since the last look, null on a first look
  readonly readVmUsage: (vm: SampledVm) => ResourceDelta | null;

  // a new baseline at a spawn or an adopt: the tap outlives its VM, so its
  // counters hold every earlier boot's traffic
  readonly startCounting: (vm: SampledVm) => void;

  // the cached sample, or a first one now when there is none for this pid
  readonly readSample: (vm: SampledVm) => ResourceSample;

  // when the sampler last saw the imp's VM; null when it never did
  readonly readLastSeenAt: (impId: string) => Date | null;

  // drops every imp not in `impIds`: its VM stopped or slept
  readonly keepOnly: (impIds: ReadonlySet<string>) => void;
}

export function createResourceSampler(readers: SamplerReaders): ResourceSampler {
  const tracked = new Map<string, Tracked>();

  const readCounters = (vm: SampledVm): Counters => {
    const stat = readers.readCpuStat(vm.impId);
    const ticks = stat === null ? readers.readCpuTicks(vm.pid) : null;
    const net = readers.readNetBytes(vm.tap);

    return {
      cpuUsec: stat?.usageUsec ?? (ticks ?? 0) * USEC_PER_TICK,
      throttledUsec: stat?.throttledUsec ?? 0,
      rx: net?.rxBytes ?? 0,
      tx: net?.txBytes ?? 0,
    };
  };

  const readVmUsage = (vm: SampledVm): ResourceDelta | null => {
    const now = readers.now();
    const counters = readCounters(vm);
    const memory = readers.readMemory(vm.pid, vm.apiSocket);
    const previous = tracked.get(vm.impId);

    // a new Firecracker: its counters start here
    if (previous?.pid !== vm.pid) {
      tracked.set(vm.impId, {
        pid: vm.pid,
        since: now,
        last: counters,
        lastAt: now,
        totals: ZERO,
        sample: buildSample(now, now, ZERO, memory, undefined),
      });

      return null;
    }

    const step = {
      cpuUsec: readStep(previous.last.cpuUsec, counters.cpuUsec),
      throttledUsec: readStep(previous.last.throttledUsec, counters.throttledUsec),
      rx: readStep(previous.last.rx, counters.rx),
      tx: readStep(previous.last.tx, counters.tx),
    };

    const intervalMs = Math.max(1, now - previous.lastAt);
    const cpuPercent = (step.cpuUsec / 1000 / intervalMs) * 100;

    const totals = {
      cpuUsec: previous.totals.cpuUsec + step.cpuUsec,
      throttledUsec: previous.totals.throttledUsec + step.throttledUsec,
      rx: previous.totals.rx + step.rx,
      tx: previous.totals.tx + step.tx,
    };

    tracked.set(vm.impId, {
      pid: vm.pid,
      since: previous.since,
      last: counters,
      lastAt: now,
      totals,
      sample: buildSample(now, previous.since, totals, memory, cpuPercent),
    });

    return {
      intervalMs,
      cpuPercent,
      cpuUsec: step.cpuUsec,
      throttledUsec: step.throttledUsec,
      netRxBytes: step.rx,
      netTxBytes: step.tx,
    };
  };

  return {
    readVmUsage,
    startCounting: (vm) => {
      tracked.delete(vm.impId);

      readVmUsage(vm);
    },
    readSample: (vm) => {
      const cached = tracked.get(vm.impId);

      if (cached?.pid === vm.pid) {
        return cached.sample;
      }

      readVmUsage(vm);

      const fresh = tracked.get(vm.impId);

      if (fresh === undefined) {
        throw new Error(`no sample of imp ${vm.impId}`);
      }

      return fresh.sample;
    },
    readLastSeenAt: (impId) => {
      const seen = tracked.get(impId);

      return seen === undefined ? null : new Date(seen.lastAt);
    },
    keepOnly: (impIds) => {
      for (const impId of tracked.keys()) {
        if (!impIds.has(impId)) {
          tracked.delete(impId);
        }
      }
    },
  };
}

// a counter that went down was reset; all of its value is new
function readStep(last: number, current: number): number {
  return current >= last ? current - last : current;
}

function buildSample(
  now: number,
  since: number,
  totals: Counters,
  memory: VmMemory,
  cpuPercent: number | undefined,
): ResourceSample {
  return {
    measuredAt: new Date(now),
    since: new Date(since),
    ...(cpuPercent !== undefined && { cpuPercent: Math.round(cpuPercent * 10) / 10 }),
    cpuThrottledMs: Math.round(totals.throttledUsec / 1000),
    netRxBytes: totals.rx,
    netTxBytes: totals.tx,
    ramMib: memory.ramMib,
    rssMib: memory.rssMib,
  };
}
