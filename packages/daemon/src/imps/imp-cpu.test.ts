import { expect, test } from 'bun:test';
import type { CpuSettings } from '../db/imps';
import { findImpByName, updateImpActivity, updateImpState, updateImpStateIf } from '../db/imps';
import type { CpuCgroups } from '../vmm/cpu-cgroups';
import { buildTestApp, setupImpTest } from './test-imps';

function formatCpu(cpu: Readonly<CpuSettings>): string {
  return `${String(cpu.limit)}/${String(cpu.weight)}`;
}

// a CpuCgroups that records what it was asked, as `verb limit/weight`
function buildRecordingCgroups() {
  const calls: string[] = [];

  const cgroups: CpuCgroups = {
    isEnforced: true,
    setup: (_impId, cpu) => {
      calls.push(`setup ${formatCpu(cpu)}`);

      return null;
    },
    apply: (_impId, cpu) => {
      calls.push(`apply ${formatCpu(cpu)}`);
    },
    adopt: (_impId, pid) => {
      calls.push(`adopt ${String(pid)}`);
    },
    remove: () => {
      calls.push('remove');

      return Promise.resolve();
    },
    removeOrphans: () => [],
    readCpuStat: () => null,
  };

  return { cgroups, calls };
}

async function setupCpuTest() {
  const recording = buildRecordingCgroups();

  const harness = await setupImpTest({ cgroups: recording.cgroups, hostCpus: 4 });

  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);

  return { ...harness, client: app.client, calls: recording.calls };
}

test('a new imp boots with its limit and weight, and a fork keeps them', async () => {
  await using ctx = await setupCpuTest();

  const created = await ctx.client.imps.create({ name: 'dev', cpuLimit: 1.5, cpuWeight: 200 });
  const forked = await ctx.client.imps.fork({ source: 'dev', name: 'copy' });

  expect(created.cpu).toEqual({ limit: 1.5, weight: 200 });
  expect(forked.cpu).toEqual({ limit: 1.5, weight: 200 });
  expect(ctx.calls).toEqual(['setup 1.5/200', 'setup 1.5/200']);
});

test('a running imp takes a new limit at once; a sleeping one at its wake', async () => {
  await using ctx = await setupCpuTest();

  await ctx.client.imps.create({ name: 'dev' });

  const running = await ctx.client.imps.update({ name: 'dev', cpuLimit: 0.5 });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.update({ name: 'dev', cpuLimit: null, cpuWeight: 300 });
  await ctx.client.imps.wake({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  expect(running.cpu).toEqual({ limit: 0.5, weight: 100 });

  // a sleep keeps the empty cgroup for the wake; a stop removes it
  expect(ctx.calls).toEqual([
    'setup null/100',
    'apply 0.5/100',
    'setup 0.5/100',
    'setup null/300',
    'remove',
  ]);
});

test('the vCPU count changes only while stopped, and limits stay within the host', async () => {
  await using ctx = await setupCpuTest();

  await ctx.client.imps.create({ name: 'dev' });

  const running = await ctx.client.imps
    .update({ name: 'dev', vcpus: 4 })
    .catch((error: unknown) => error);

  const tooMany = await ctx.client.imps
    .update({ name: 'dev', cpuLimit: 5 })
    .catch((error: unknown) => error);

  const tooFew = await ctx.client.imps
    .update({ name: 'dev', cpuLimit: 0.05 })
    .catch((error: unknown) => error);

  const badWeight = await ctx.client.imps
    .update({ name: 'dev', cpuWeight: 0 })
    .catch((error: unknown) => error);

  await ctx.client.imps.stop({ name: 'dev' });

  const stopped = await ctx.client.imps.update({ name: 'dev', vcpus: 4 });

  expect(running).toMatchObject({ code: 'INVALID_STATE' });
  expect(tooMany).toMatchObject({ code: 'BAD_REQUEST' });
  expect(tooFew).toMatchObject({ code: 'BAD_REQUEST' });
  expect(badWeight).toMatchObject({ code: 'BAD_REQUEST' });
  expect(stopped.vcpus).toBe(4);
});

test('wakes and awake time count, and a liveness repair after a crash closes the span', async () => {
  await using ctx = await setupCpuTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  const awake = await findImpByName(ctx.db, 'dev');

  expect(awake?.wakeCount).toBe(1);
  expect(awake?.awakeSince).toBeInstanceOf(Date);

  // impd crashed while it ran: the record still says running, and the
  // re-adopt keeps the span open from where it was
  const since = awake?.awakeSince?.getTime() ?? 0;

  await updateImpState(ctx.db, awake?.id ?? '', { reason: 'adopted', state: 'running' });

  const adopted = await findImpByName(ctx.db, 'dev');

  expect(adopted?.awakeSince?.getTime()).toBe(since);

  // the VM was last active 2 s into its span, then died; the span ends at
  // that activity, not at the repair
  await updateImpActivity(ctx.db, awake?.id ?? '', new Date(since + 2000));

  ctx.fake.alive.delete(awake?.pid ?? 0);

  await Bun.sleep(5);

  const api = await ctx.client.imps.get({ name: 'dev' });
  const repaired = await findImpByName(ctx.db, 'dev');

  expect(api.state).toBe('stopped');
  expect(ctx.calls.at(-1)).toBe('remove');
  expect(repaired?.awakeSince).toBeNull();
  expect(repaired?.awakeMs).toBe(2000 + (awake?.awakeMs ?? 0));
  expect(api.resources).toMatchObject({ wakeCount: 1, awakeMs: repaired?.awakeMs });
});

test('a span cannot end before it starts, and a cold boot for a wake counts as a wake', async () => {
  await using ctx = await setupCpuTest();

  await ctx.client.imps.create({ name: 'dev' });

  const running = await findImpByName(ctx.db, 'dev');

  const since = running?.awakeSince?.getTime() ?? 0;

  const repaired = await updateImpStateIf(
    ctx.db,
    running?.id ?? '',
    { state: 'running', pid: running?.pid ?? null },
    { reason: 'repaired', state: 'stopped', pid: null, awakeUntil: new Date(since - 5000) },
  );

  expect(repaired?.awakeMs).toBe(0);

  await ctx.client.imps.start({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  ctx.fake.queue('wake', 'fail');

  const cold = await ctx.client.imps.wake({ name: 'dev' });

  expect(cold.state).toBe('running');
  expect(cold.resources?.wakeCount).toBe(1);
});

test('a running imp shows the sampler cache: RAM, then CPU after a second pass', async () => {
  const stat = { usageUsec: 1_000_000, throttledUsec: 0 };
  const recording = buildRecordingCgroups();

  await using ctx = await setupImpTest({
    cgroups: { ...recording.cgroups, readCpuStat: () => ({ ...stat }) },
  });

  await ctx.createTestImage('ubuntu');

  const app = buildTestApp(ctx, ctx);

  await app.client.imps.create({ name: 'dev' });

  const first = await app.client.imps.get({ name: 'dev' });

  expect(first.ramMib).toBeNumber();
  expect(first.resources?.sample?.cpuPercent).toBeUndefined();

  // half a core for 5 s, 2 s of it held back
  ctx.advance(5000);

  stat.usageUsec += 2_500_000;
  stat.throttledUsec += 2_000_000;

  await ctx.imps.sampleResources();

  const second = await app.client.imps.get({ name: 'dev' });

  expect(second.resources?.sample?.cpuPercent).toBe(50);
  expect(second.resources?.sample?.cpuThrottledMs).toBe(2000);
});
