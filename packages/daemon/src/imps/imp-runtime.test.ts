import { expect, test } from 'bun:test';
import { findImpByName, updateImpActivity, updateImpHold } from '../db/imps';
import { setupImpTest } from './test-imps';

async function setupRunningImp() {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  return { ...ctx, impId: imp.id };
}

test('a background sleep skips an imp that was held after the caller looked', async () => {
  await using ctx = await setupRunningImp();

  const id = ctx.impId;

  const seen = await findImpByName(ctx.db, 'dev');

  await updateImpHold(ctx.db, id, new Date(Date.now() + 60_000));

  const byIdle = await ctx.imps.trySleepImp(id, 'idle', {
    by: 'idle',
    seenActiveAt: seen?.lastActiveAt.getTime() ?? 0,
  });

  const byGovernor = await ctx.imps.trySleepImp(id, 'budget', { by: 'governor' });

  expect([byIdle, byGovernor]).toEqual(['skipped', 'skipped']);
});

test('the idle loop skips an imp active since it looked; the governor does not', async () => {
  await using ctx = await setupRunningImp();

  const id = ctx.impId;

  const seen = await findImpByName(ctx.db, 'dev');

  const seenActiveAt = seen?.lastActiveAt.getTime() ?? 0;

  await updateImpActivity(ctx.db, id, new Date(seenActiveAt + 1000));

  const byIdle = await ctx.imps.trySleepImp(id, 'idle', { by: 'idle', seenActiveAt });
  const byGovernor = await ctx.imps.trySleepImp(id, 'budget', { by: 'governor' });

  expect([byIdle, byGovernor]).toEqual(['skipped', 'slept']);
});

test('a background sleep skips an imp with an open connection or a taken lock', async () => {
  await using ctx = await setupRunningImp();

  const id = ctx.impId;
  const release = ctx.imps.tracker.open(id, 'proxy');

  const connected = await ctx.imps.trySleepImp(id, 'budget', { by: 'governor' });

  release();

  const gate = Promise.withResolvers<void>();
  const holding = ctx.imps.lockImp('dev', () => gate.promise);

  await Bun.sleep(5);

  const locked = await ctx.imps.trySleepImp(id, 'budget', { by: 'governor' });

  gate.resolve();

  await holding;

  expect([connected, locked]).toEqual(['skipped', 'skipped']);
});

test('impd stopping sleeps held and connected imps too', async () => {
  await using ctx = await setupRunningImp();

  const id = ctx.impId;

  await updateImpHold(ctx.db, id, new Date(Date.now() + 60_000));

  const release = ctx.imps.tracker.open(id, 'exec');

  await ctx.imps.sleepAllImps();

  release();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp?.state).toBe('sleeping');
});
