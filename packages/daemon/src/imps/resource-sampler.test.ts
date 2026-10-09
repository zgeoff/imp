import { expect, test } from 'bun:test';
import type { CpuStat } from '../vmm/cpu-cgroups';
import { createResourceSampler } from './resource-sampler';

// a sampler over counters the test sets, on a clock it moves
function setupTest() {
  const state = {
    now: 0,
    cpu: { usageUsec: 0, throttledUsec: 0 } as CpuStat | null,
    ticks: 0,
    net: { rxBytes: 0, txBytes: 0 },
    memory: { ramMib: null as number | null, rssMib: null as number | null },
    memoryReads: 0,
  };

  const sampler = createResourceSampler({
    now: () => state.now,
    readCpuStat: () => state.cpu,
    readCpuTicks: () => state.ticks,
    readNetBytes: () => state.net,
    readMemory: () => {
      state.memoryReads += 1;

      return state.memory;
    },
  });

  return { state, sampler };
}

test('#readVmUsage answers nothing on its first look at a VM', () => {
  const ctx = setupTest();

  ctx.state.cpu = { usageUsec: 9_000_000, throttledUsec: 1_000_000 };
  ctx.state.net = { rxBytes: 500, txBytes: 50 };

  expect(
    ctx.sampler.readVmUsage({ impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' }),
  ).toBeNull();
});

test('#readVmUsage gives the CPU and the traffic used since its last look', () => {
  const ctx = setupTest();
  const vm = { impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' };

  ctx.state.cpu = { usageUsec: 9_000_000, throttledUsec: 1_000_000 };
  ctx.state.net = { rxBytes: 500, txBytes: 50 };

  ctx.sampler.readVmUsage(vm);

  ctx.state.now = 5000;
  ctx.state.cpu = { usageUsec: 11_500_000, throttledUsec: 1_200_000 };
  ctx.state.net = { rxBytes: 1500, txBytes: 80 };

  const delta = ctx.sampler.readVmUsage(vm);

  expect(delta).toStrictEqual({
    intervalMs: 5000,
    cpuPercent: 50,
    cpuUsec: 2_500_000,
    throttledUsec: 200_000,
    netRxBytes: 1000,
    netTxBytes: 30,
  });
});

test('#readSample shows the totals since the first look, and the memory of the last', () => {
  const ctx = setupTest();
  const vm = { impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' };

  ctx.state.cpu = { usageUsec: 9_000_000, throttledUsec: 1_000_000 };
  ctx.state.net = { rxBytes: 500, txBytes: 50 };

  ctx.sampler.readVmUsage(vm);

  ctx.state.now = 5000;
  ctx.state.cpu = { usageUsec: 11_500_000, throttledUsec: 1_200_000 };
  ctx.state.net = { rxBytes: 1500, txBytes: 80 };
  ctx.state.memory = { ramMib: 300, rssMib: 340 };

  ctx.sampler.readVmUsage(vm);

  expect(ctx.sampler.readSample(vm)).toStrictEqual({
    measuredAt: new Date(5000),
    since: new Date(0),
    cpuPercent: 50,
    cpuThrottledMs: 200,
    netRxBytes: 1000,
    netTxBytes: 30,
    ramMib: 300,
    rssMib: 340,
  });
});

test('#readVmUsage counts a counter that dropped as reset, so its whole value is new', () => {
  const ctx = setupTest();
  const vm = { impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' };

  ctx.state.net = { rxBytes: 1000, txBytes: 0 };

  ctx.sampler.readVmUsage(vm);

  // the tap was made again: its counter starts from zero
  ctx.state.now = 1000;
  ctx.state.net = { rxBytes: 40, txBytes: 0 };

  expect(ctx.sampler.readVmUsage(vm)?.netRxBytes).toBe(40);
});

test('#readVmUsage starts the counts again for a VM with a new pid', () => {
  const ctx = setupTest();

  ctx.sampler.readVmUsage({ impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' });

  ctx.state.now = 2000;

  expect(
    ctx.sampler.readVmUsage({ impId: 'a', pid: 11, apiSocket: '/api', tap: 'imp0' }),
  ).toBeNull();
});

test('#readSample counts a new pid from its first look', () => {
  const ctx = setupTest();

  ctx.sampler.readVmUsage({ impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' });

  ctx.state.now = 2000;

  const sample = ctx.sampler.readSample({ impId: 'a', pid: 11, apiSocket: '/api', tap: 'imp0' });

  expect(sample.since).toStrictEqual(new Date(2000));
});

test('#readVmUsage counts the ticks of the pid when the VM has no cgroup', () => {
  const ctx = setupTest();
  const vm = { impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' };

  ctx.state.cpu = null;
  ctx.state.ticks = 100;

  ctx.sampler.readVmUsage(vm);

  ctx.state.now = 1000;
  ctx.state.ticks = 150;

  expect(ctx.sampler.readVmUsage(vm)?.cpuPercent).toBe(50);
});

test('#readSample answers the cached sample of a pid without reading again', () => {
  const ctx = setupTest();
  const vm = { impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' };
  const first = ctx.sampler.readSample(vm);
  const again = ctx.sampler.readSample(vm);

  expect(again).toBe(first);
  expect(ctx.state.memoryReads).toBe(1);
});

test('#readSample reads again for an imp keepOnly dropped', () => {
  const ctx = setupTest();
  const vm = { impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' };

  ctx.sampler.readSample(vm);
  ctx.sampler.keepOnly(new Set());
  ctx.sampler.readSample(vm);

  expect(ctx.state.memoryReads).toBe(2);
});

test('#keepOnly keeps the samples of the imps it names', () => {
  const ctx = setupTest();
  const vm = { impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' };

  ctx.sampler.readSample(vm);
  ctx.sampler.keepOnly(new Set(['a']));
  ctx.sampler.readSample(vm);

  expect(ctx.state.memoryReads).toBe(1);
});

test('#startCounting takes a new baseline for a VM, though its tap holds earlier traffic', () => {
  const ctx = setupTest();
  const vm = { impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' };

  // the last boot's traffic, still on the tap that outlived it
  ctx.state.net = { rxBytes: 9000, txBytes: 900 };
  ctx.state.now = 1000;

  ctx.sampler.startCounting(vm);

  ctx.state.now = 6000;
  ctx.state.net = { rxBytes: 9100, txBytes: 910 };

  ctx.sampler.readVmUsage(vm);

  // impd adopts the same VM: its counts start again at the adopt
  ctx.state.now = 7000;

  ctx.sampler.startCounting(vm);

  const sample = ctx.sampler.readSample(vm);

  expect(sample.since).toStrictEqual(new Date(7000));
  expect(sample.netRxBytes).toBe(0);
});

test('#startCounting counts the traffic after the baseline only', () => {
  const ctx = setupTest();
  const vm = { impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' };

  ctx.state.net = { rxBytes: 9100, txBytes: 910 };
  ctx.state.now = 7000;

  ctx.sampler.startCounting(vm);

  ctx.state.now = 12_000;
  ctx.state.net = { rxBytes: 9150, txBytes: 915 };

  ctx.sampler.readVmUsage(vm);

  expect(ctx.sampler.readSample(vm)).toStrictEqual({
    measuredAt: new Date(12_000),
    since: new Date(7000),
    cpuPercent: 0,
    cpuThrottledMs: 0,
    netRxBytes: 50,
    netTxBytes: 5,
    ramMib: null,
    rssMib: null,
  });
});

test('#readLastSeenAt answers null for an imp the sampler never saw', () => {
  const ctx = setupTest();

  expect(ctx.sampler.readLastSeenAt('a')).toBeNull();
});

test('#readLastSeenAt answers the time of the last look at the imp', () => {
  const ctx = setupTest();
  const vm = { impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' };

  ctx.state.now = 1000;

  ctx.sampler.readVmUsage(vm);

  ctx.state.now = 4000;

  ctx.sampler.readVmUsage(vm);

  expect(ctx.sampler.readLastSeenAt('a')).toStrictEqual(new Date(4000));
});

test('#readLastSeenAt answers null for an imp keepOnly dropped', () => {
  const ctx = setupTest();

  ctx.sampler.readVmUsage({ impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' });
  ctx.sampler.keepOnly(new Set());

  expect(ctx.sampler.readLastSeenAt('a')).toBeNull();
});
