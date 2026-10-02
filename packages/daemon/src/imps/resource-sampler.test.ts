import { expect, test } from 'bun:test';
import type { CpuStat } from '../vmm/cpu-cgroups';
import { createResourceSampler } from './resource-sampler';

const VM = { impId: 'a', pid: 10, apiSocket: '/api', tap: 'imp0' };

// a sampler over counters the test sets, on a clock it moves
function setupSampler() {
  const state = {
    now: 0,
    cpu: { usageUsec: 0, throttledUsec: 0 } as CpuStat | null,
    ticks: 0,
    net: { rxBytes: 0, txBytes: 0 },
    memoryReads: 0,
  };

  const sampler = createResourceSampler({
    now: () => state.now,
    readCpuStat: () => state.cpu,
    readCpuTicks: () => state.ticks,
    readNetBytes: () => state.net,
    readMemory: () => {
      state.memoryReads += 1;

      return { ramMib: 300, rssMib: 340 };
    },
  });

  return { state, sampler };
}

test('the first look starts the counters; the next gives CPU and traffic since', () => {
  const ctx = setupSampler();

  ctx.state.cpu = { usageUsec: 9_000_000, throttledUsec: 1_000_000 };
  ctx.state.net = { rxBytes: 500, txBytes: 50 };

  expect(ctx.sampler.readVmUsage(VM)).toBeNull();

  ctx.state.now = 5000;
  ctx.state.cpu = { usageUsec: 11_500_000, throttledUsec: 1_200_000 };
  ctx.state.net = { rxBytes: 1500, txBytes: 80 };

  const delta = ctx.sampler.readVmUsage(VM);

  expect(delta).toEqual({
    intervalMs: 5000,
    cpuPercent: 50,
    cpuUsec: 2_500_000,
    throttledUsec: 200_000,
    netRxBytes: 1000,
    netTxBytes: 30,
  });

  expect(ctx.sampler.readSample(VM)).toEqual({
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

test('a counter that drops is a reset, and a new pid starts the counts again', () => {
  const ctx = setupSampler();

  ctx.state.net = { rxBytes: 1000, txBytes: 0 };

  ctx.sampler.readVmUsage(VM);

  // the tap was made again: its counter starts from zero
  ctx.state.now = 1000;
  ctx.state.net = { rxBytes: 40, txBytes: 0 };

  expect(ctx.sampler.readVmUsage(VM)?.netRxBytes).toBe(40);

  ctx.state.now = 2000;

  expect(ctx.sampler.readVmUsage({ ...VM, pid: 11 })).toBeNull();
  expect(ctx.sampler.readSample({ ...VM, pid: 11 }).since).toEqual(new Date(2000));
});

test('without a cgroup the pid ticks count, and a read caches one sample per pid', () => {
  const ctx = setupSampler();

  ctx.state.cpu = null;
  ctx.state.ticks = 100;

  const first = ctx.sampler.readSample(VM);
  const again = ctx.sampler.readSample(VM);

  ctx.state.now = 1000;
  ctx.state.ticks = 150;

  const delta = ctx.sampler.readVmUsage(VM);

  expect(first).toBe(again);
  expect(ctx.state.memoryReads).toBe(2);
  expect(delta?.cpuPercent).toBe(50);

  ctx.sampler.keepOnly(new Set());
  ctx.sampler.readSample(VM);

  expect(ctx.state.memoryReads).toBe(3);
});

test('a spawn or an adopt takes a new baseline: the tap still holds earlier traffic', () => {
  const ctx = setupSampler();

  // the last boot's traffic, still on the tap that outlived it
  ctx.state.net = { rxBytes: 9000, txBytes: 900 };
  ctx.state.now = 1000;

  ctx.sampler.startCounting(VM);

  ctx.state.now = 6000;
  ctx.state.net = { rxBytes: 9100, txBytes: 910 };

  ctx.sampler.readVmUsage(VM);

  // impd adopts the same VM: its counts start again at the adopt
  ctx.state.now = 7000;

  ctx.sampler.startCounting(VM);

  const sample = ctx.sampler.readSample(VM);

  expect(sample.since).toEqual(new Date(7000));
  expect(sample.netRxBytes).toBe(0);

  ctx.state.now = 12_000;
  ctx.state.net = { rxBytes: 9150, txBytes: 915 };

  ctx.sampler.readVmUsage(VM);

  expect(ctx.sampler.readSample(VM)).toMatchObject({ netRxBytes: 50, netTxBytes: 5 });
});
