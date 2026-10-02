import { expect, test } from 'bun:test';
import { findImpByName, updateImpActivity, updateImpHold } from '../db/imps';
import { setupImpTest, waitForOutcome } from './test-imps';

// these tests wait up to 10 s for held calls to settle; a loaded host is slow
const SLOW_TEST_TIMEOUT_MS = 30_000;

async function setupRunningImp(env: Readonly<Record<string, string>> = {}) {
  const ctx = await setupImpTest({ env });

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

test('a sleep right after a cold boot waits until the guest is old enough', async () => {
  await using ctx = await setupRunningImp({ IMP_SLEEP_MIN_GUEST_UPTIME_MS: '300' });

  ctx.fake.setGuestUptime(100);

  const started = performance.now();

  const asleep = await ctx.imps.sleepImp('dev');

  expect(asleep.state).toBe('sleeping');
  expect(performance.now() - started).toBeGreaterThanOrEqual(190);
  expect(ctx.logs.some((line) => line.includes('for a young guest'))).toBe(true);
});

test('an idle sleep that waits for a young guest gives way to a request', async () => {
  await using ctx = await setupRunningImp({ IMP_SLEEP_MIN_GUEST_UPTIME_MS: '5000' });

  ctx.fake.setGuestUptime(0);

  const seen = await findImpByName(ctx.db, 'dev');

  const seenActiveAt = seen?.lastActiveAt.getTime() ?? 0;
  const started = performance.now();
  const sleeping = ctx.imps.trySleepImp(ctx.impId, 'idle', { by: 'idle', seenActiveAt });

  await Bun.sleep(20);

  // as the wake proxy does: the connection counts before it waits for the lock
  const opened = { release: () => {} };

  const request = ctx.imps.requireRunning('dev', (found) => {
    opened.release = ctx.imps.tracker.open(found.id, 'proxy');
  });

  const [outcome, running] = await Promise.all([sleeping, request]);

  opened.release();

  expect(outcome).toBe('skipped');
  expect(running).toMatchObject({ imp: { state: 'running' }, wokeMs: null });
  expect(performance.now() - started).toBeLessThan(2000);
});

test('an idle sleep that waits for a young guest gives way to a hold', async () => {
  await using ctx = await setupRunningImp({ IMP_SLEEP_MIN_GUEST_UPTIME_MS: '5000' });

  ctx.fake.setGuestUptime(0);

  const seen = await findImpByName(ctx.db, 'dev');

  const seenActiveAt = seen?.lastActiveAt.getTime() ?? 0;
  const started = performance.now();
  const sleeping = ctx.imps.trySleepImp(ctx.impId, 'idle', { by: 'idle', seenActiveAt });

  await Bun.sleep(20);

  await updateImpHold(ctx.db, ctx.impId, new Date(Date.now() + 60_000));

  const outcome = await sleeping;
  const imp = await findImpByName(ctx.db, 'dev');

  expect(outcome).toBe('skipped');
  expect(imp?.state).toBe('running');
  expect(performance.now() - started).toBeLessThan(2000);
});

test('the governor sleeps young guests at once to admit a boot', async () => {
  // three imps own 300 MiB each; a 720 MiB boot needs all three asleep
  await using ctx = await setupImpTest({
    env: {
      IMP_RAM_BUDGET_MIB: '1000',
      IMP_DEFAULT_MEMORY_MIB: '256',
      IMP_BOOT_RESERVE_PERCENT: '100',
      IMP_SLEEP_MIN_GUEST_UPTIME_MS: '5000',
    },
  });

  await ctx.createTestImage('ubuntu');

  for (const name of ['a', 'b', 'c']) {
    await ctx.imps.createImp({ name });
  }

  ctx.fake.setGuestUptime(0);

  const started = performance.now();

  await ctx.imps.createImp({ name: 'big', memoryMib: 720 });

  const imps = await ctx.imps.listImps();

  expect(imps.map((imp) => [imp.name, imp.state])).toEqual([
    ['a', 'sleeping'],
    ['b', 'sleeping'],
    ['big', 'running'],
    ['c', 'sleeping'],
  ]);

  expect(performance.now() - started).toBeLessThan(2000);
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

test('a tunnel counts as a tunnel, not an exec, from before the wake', async () => {
  await using ctx = await setupRunningImp();

  const id = ctx.impId;

  await ctx.imps.stopImp('dev');

  const gate = ctx.fake.hold('boot');

  ctx.fake.queue('boot', 'fail');

  const dial = ctx.imps.openDial('dev', { network: 'tcp', address: '127.0.0.1:5432' }, 'tunnel');

  await gate.reached;

  const during = {
    tunnel: ctx.imps.tracker.count(id, 'tunnel'),
    exec: ctx.imps.tracker.count(id, 'exec'),
  };

  gate.release();

  await dial.catch(() => null);

  expect(during).toEqual({ tunnel: 1, exec: 0 });
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

test('a session exec on an agent from before sessions fails before it connects', async () => {
  await using ctx = await setupRunningImp();

  const rejection = await ctx.imps
    .openExec('dev', { argv: ['sh'], tty: true, session: 'main' })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'AGENT_OUTDATED' });
  expect(ctx.imps.tracker.count(ctx.impId)).toBe(0);
});
