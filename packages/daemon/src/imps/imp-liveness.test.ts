import { expect, test } from 'bun:test';
import { buildImpPaths } from '../storage/data-layout';
import type { CpuCgroups } from '../vmm/cpu-cgroups';
import { setupImpTest, writeTestSnapshot } from './test-imps';

test('a VM that died after its sleep wrote the snapshot is asleep, not stopped', async () => {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  // impd stopped between the snapshot and the record update
  writeTestSnapshot(paths, Date.now() + 1000, ctx.readIdentity());

  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');
  const woken = await ctx.imps.wakeImp('dev');

  expect(found.state).toBe('sleeping');
  expect(woken.state).toBe('running');
  expect(ctx.fake.wakes).toHaveLength(1);
});

test('a dead VM with a snapshot from an earlier sleep is stopped', async () => {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.sleepImp('dev');
  await Bun.sleep(5);
  await ctx.imps.wakeImp('dev');

  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');

  expect(found.state).toBe('stopped');
});

test('a VM that its memory limit killed is stopped, and says so', async () => {
  const cgroups: CpuCgroups = {
    isEnforced: true,
    isMemoryEnforced: true,
    readOomKills: () => 1,
    hasOomKillSinceStart: () => true,
    setup: () => null,
    apply: () => {},
    adopt: () => {},
    remove: () => Promise.resolve(),
    setGuestMib: () => {},
    kill: () => {},
    removeOrphans: () => [],
    readCpuStat: () => null,
  };

  const ctx = await setupImpTest({ cgroups });

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');

  expect(found.state).toBe('stopped');
  expect(found.error).toBe('its memory limit killed firecracker');
});
