import { expect, test } from 'bun:test';
import { findImpByName, updateImpActivity, updateImpHold } from '../db/imps';
import { setupImpTest, waitForOutcome } from './test-imps';

// these tests wait up to 10 s for held calls to settle; a loaded host is slow
const SLOW_TEST_TIMEOUT_MS = 30_000;

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

test('exec counts its session before the wake and drops it when the wake fails', async () => {
  await using ctx = await setupRunningImp();

  const id = ctx.impId;

  await ctx.imps.stopImp('dev');

  const gate = ctx.fake.hold('boot');

  ctx.fake.queue('boot', 'fail');

  const exec = ctx.imps.openExec('dev', { argv: ['true'], tty: false });

  await gate.reached;

  const during = ctx.imps.tracker.count(id, 'exec');

  gate.release();

  const rejection = await exec.catch((error: unknown) => error);

  expect(during).toBe(1);
  expect(rejection).toBeInstanceOf(Error);
  expect(ctx.imps.tracker.count(id)).toBe(0);
});

test('impd stopping waits for a boot under way, sleeps that imp, and refuses later boots', async () => {
  await using ctx = await setupRunningImp();

  await ctx.imps.stopImp('dev');

  const gate = ctx.fake.hold('boot');
  const starting = ctx.imps.startImp('dev');

  await gate.reached;

  const stopping = ctx.imps.sleepAllImps();

  await Bun.sleep(5);

  gate.release();

  await Promise.all([starting, stopping]);

  const later = await ctx.imps.startImp('dev').catch((error: unknown) => error);
  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp?.state).toBe('sleeping');
  expect(later).toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'impd is stopping' });
});

test(
  'a governor pass during impd stopping neither hangs nor wakes anything',
  async () => {
    await using ctx = await setupImpTest({
      env: { IMP_RAM_BUDGET_MIB: '500', IMP_DEFAULT_MEMORY_MIB: '256' },
    });

    await ctx.createTestImage('ubuntu');
    await ctx.imps.createImp({ name: 'a' });
    await ctx.imps.createImp({ name: 'b' });

    const gate = ctx.fake.hold('sleep');

    // 600 MiB awake against a budget of 500: the pass wants one asleep
    const enforcing = ctx.governor.enforce();
    const stopping = ctx.imps.sleepAllImps();

    await gate.reached;

    gate.release();

    const outcomes = await Promise.all([
      waitForOutcome(enforcing, 10_000),
      waitForOutcome(stopping, 10_000),
    ]);

    const imps = await ctx.imps.listImps();

    expect(outcomes).toEqual(['done', 'done']);
    expect(imps.map((imp) => imp.state)).toEqual(['sleeping', 'sleeping']);
  },
  SLOW_TEST_TIMEOUT_MS,
);

test('a create that impd stopping cuts short is recorded as an error', async () => {
  await using ctx = await setupRunningImp();

  await ctx.imps.sleepAllImps();

  const rejection = await ctx.imps.createImp({ name: 'late' }).catch((error: unknown) => error);
  const late = await findImpByName(ctx.db, 'late');

  expect(rejection).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(late).toMatchObject({ state: 'error', error: 'impd is stopping' });
});

test('a destroy issued while the create boots waits for it, then removes the imp', async () => {
  await using ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');

  const gate = ctx.fake.hold('boot');
  const creating = ctx.imps.createImp({ name: 'dev' });

  await gate.reached;

  const destroying = ctx.imps.destroyImp('dev');

  await Bun.sleep(5);

  gate.release();

  const created = await creating;

  await destroying;

  const left = await findImpByName(ctx.db, 'dev');

  expect(created.state).toBe('running');
  expect(left).toBeUndefined();
  expect(ctx.fake.alive.size).toBe(0);
});
