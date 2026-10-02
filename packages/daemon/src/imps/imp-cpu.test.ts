import { expect, test } from 'bun:test';
import type { CpuSettings } from '../db/imps';
import { findImpByName, updateImpState, updateImpStateIf } from '../db/imps';
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

  // a sleep and a stop leave no cgroup behind
  expect(ctx.calls).toEqual([
    'setup null/100',
    'apply 0.5/100',
    'setup 0.5/100',
    'remove',
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

  // the VM died meanwhile: the repair closes the span
  await Bun.sleep(5);

  const repaired = await updateImpStateIf(
    ctx.db,
    awake?.id ?? '',
    { state: 'running', pid: awake?.pid ?? null },
    { reason: 'repaired', state: 'stopped', pid: null },
  );

  expect(repaired?.awakeSince).toBeNull();
  expect(repaired?.awakeMs).toBeGreaterThanOrEqual(Date.now() - since - 1000);
  expect(repaired?.awakeMs).toBeGreaterThan(0);

  const api = await ctx.client.imps.get({ name: 'dev' });

  expect(api.resources).toMatchObject({ wakeCount: 1, awakeMs: repaired?.awakeMs });
});
