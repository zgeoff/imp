import { expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { findImpByName } from '../db/imps';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { buildImpPaths, buildWatchdogSlot } from '../storage/data-layout';

// an imp whose agent stops answering under each policy, over the fake VMM
async function setupWatchdogTest(action: string) {
  const ctx = await setupImpTest({
    env: { IMP_WATCHDOG_ACTION: action, IMP_WATCHDOG_TIMEOUT_S: '10' },
  });

  await ctx.createTestImage('ubuntu');

  const client = buildTestApp(ctx, ctx).client;

  await client.imps.create({ name: 'dev' });

  const created = await findImpByName(ctx.db, 'dev');

  if (created === undefined) {
    throw new Error('no imp');
  }

  // the idle loop's two looks, 11 s apart; the confirming ping fails too
  const runSilence = async () => {
    const imp = await findImpByName(ctx.db, 'dev');

    if (imp === undefined) {
      throw new Error('no imp');
    }

    ctx.imps.watchdog.observe(imp, false);
    ctx.advance(11_000);
    ctx.fake.queue('agentReady', 'fail');
    ctx.imps.watchdog.observe(imp, false);

    await ctx.imps.watchdog.settle();
  };

  return { ...ctx, client, created, runSilence, paths: buildImpPaths(ctx.dataDir, created.id) };
}

test('report: the imp says since when its agent is silent, and keeps running', async () => {
  await using ctx = await setupWatchdogTest('report');

  await ctx.runSilence();

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.state).toBe('running');
  expect(imp.agentSilentSince).toBeInstanceOf(Date);
  expect(ctx.fake.alive.has(ctx.created.pid ?? 0)).toBeTrue();
});

test('restart: the VM is killed and the imp boots cold, saying why', async () => {
  await using ctx = await setupWatchdogTest('restart');

  await ctx.runSilence();

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(ctx.fake.alive.has(ctx.created.pid ?? 0)).toBeFalse();
  expect(ctx.fake.stops).toContainEqual({ pid: ctx.created.pid ?? 0, graceful: false });
  expect(imp.state).toBe('running');
  expect(imp.coldBootReason).toBe('the watchdog restarted it: its agent stopped answering');
  expect(imp.agentSilentSince).toBeUndefined();
});

test('snapshot: the memory goes to the owner-only watchdog slot, then a cold boot', async () => {
  await using ctx = await setupWatchdogTest('snapshot');

  await ctx.runSilence();

  const slot = buildWatchdogSlot(ctx.paths.dir);

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(statSync(slot.snapshotDir).mode & 0o777).toBe(0o700);
  expect(statSync(slot.memFile).mode & 0o777).toBe(0o600);
  expect(statSync(slot.snapshotMeta).mode & 0o777).toBe(0o600);
  expect(imp.state).toBe('running');
  expect(ctx.fake.alive.has(ctx.created.pid ?? 0)).toBeFalse();

  // a destroy takes the slot with the imp
  await ctx.client.imps.destroy({ name: 'dev' });

  expect(existsSync(slot.snapshotDir)).toBeFalse();
});

test('snapshot: without disk room the imp still boots cold, with no slot', async () => {
  await using ctx = await setupWatchdogTest('snapshot');

  // below the 5 GiB reserve
  ctx.diskUsage.availableBytes = 4 * 1024 ** 3;

  await ctx.runSilence();

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(existsSync(buildWatchdogSlot(ctx.paths.dir).snapshotDir)).toBeFalse();
  expect(imp.state).toBe('running');
  expect(ctx.fake.alive.has(ctx.created.pid ?? 0)).toBeFalse();
});
