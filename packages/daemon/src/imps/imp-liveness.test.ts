import { expect, onTestFinished, test } from 'bun:test';
import { buildImpPaths } from '../storage/data-layout';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { createImpTest, writeTestSnapshot } from './test-imps';
import type { ImpTestOptions } from './test-imps';

async function setupTest(options: ImpTestOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, options);

  // the image every imp boots from
  await harness.createTestImage('ubuntu');

  return harness;
}

test('it finds a VM that died after its sleep wrote the snapshot asleep, not stopped', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  // impd stopped between the snapshot and the record update
  writeTestSnapshot(
    buildImpPaths(ctx.dataDir, imp.id),
    imp.lastActiveAt.getTime() + 1000,
    ctx.readIdentity(),
  );

  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');

  expect(found.state).toBe('sleeping');
});

test('it wakes an imp found asleep after its VM died from the snapshot', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  // impd stopped between the snapshot and the record update
  writeTestSnapshot(
    buildImpPaths(ctx.dataDir, imp.id),
    imp.lastActiveAt.getTime() + 1000,
    ctx.readIdentity(),
  );

  ctx.fake.alive.clear();

  await ctx.imps.getImp('dev');

  const woken = await ctx.imps.wakeImp('dev');

  expect(woken.state).toBe('running');
  expect(ctx.fake.wakes).toHaveLength(1);
});

test('it finds a dead VM with a snapshot from before its last activity stopped', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  // an earlier sleep's snapshot, which the imp ran past
  writeTestSnapshot(
    buildImpPaths(ctx.dataDir, imp.id),
    imp.lastActiveAt.getTime() - 1000,
    ctx.readIdentity(),
  );

  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');

  expect(found.state).toBe('stopped');
});

test('it finds a VM that its memory limit killed stopped, and says so', async () => {
  const stub = buildStubCpuCgroups({ isMemoryEnforced: true });

  const ctx = await setupTest({ cgroups: stub.cgroups });
  const imp = await ctx.imps.createImp({ name: 'dev' });

  stub.oomKills.set(imp.id, 1);
  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');

  expect(found.state).toBe('stopped');
  expect(found.error).toBe('its memory limit killed firecracker');
});
