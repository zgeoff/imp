import { expect, mock, test } from 'bun:test';
import { buildMockImpRecord } from '../test-utils/build-mock-imp-record';
import { createAgentWatchdog } from './agent-watchdog';

// A clock the test moves and the watchdog's log; the agent's answer to the
// longer ping and the recovery are the test's to give.
function setupTest() {
  const clock = { nowMs: 0 };
  const logs: string[] = [];

  return {
    clock,
    logs,
    deps: {
      now: () => clock.nowMs,
      log: (message: string) => {
        logs.push(message);
      },
    },
  };
}

test('it reports a silent agent once, past the timeout and a failed ping', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });
  const recover = mock(() => Promise.resolve(true));

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(true),
    recover,
    timeoutMs: 60_000,
    action: 'report',
  });

  watchdog.observe(imp, false);

  ctx.clock.nowMs = 60_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  ctx.clock.nowMs = 62_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  expect(watchdog.readSilentSince(imp.id)).toStrictEqual(new Date(0));

  expect(ctx.logs).toStrictEqual([
    'impd: dev: the agent has not answered for 60s; its VM still runs (watchdog: report)',
  ]);

  expect(recover).not.toHaveBeenCalled();
});

test('it reports no silence before the timeout', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(true),
    recover: () => Promise.resolve(true),
    timeoutMs: 60_000,
    action: 'report',
  });

  watchdog.observe(imp, false);

  ctx.clock.nowMs = 59_999;

  watchdog.observe(imp, false);

  await watchdog.settle();

  expect(watchdog.readSilentSince(imp.id)).toBeNull();
  expect(ctx.logs).toStrictEqual([]);
});

test('it reports no silence for an agent that answers the longer ping', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(false),
    recover: () => Promise.resolve(true),
    timeoutMs: 60_000,
    action: 'report',
  });

  watchdog.observe(imp, false);

  ctx.clock.nowMs = 61_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  expect(watchdog.readSilentSince(imp.id)).toBeNull();
  expect(ctx.logs).toStrictEqual([]);
});

test('it ends a reported silence and logs it when the idle loop gets an answer again', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(true),
    recover: () => Promise.resolve(true),
    timeoutMs: 60_000,
    action: 'report',
  });

  watchdog.observe(imp, false);

  ctx.clock.nowMs = 61_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  ctx.clock.nowMs = 62_000;

  watchdog.observe(imp, true);

  expect(watchdog.readSilentSince(imp.id)).toBeNull();
  expect(ctx.logs.at(-1)).toBe('impd: dev: the agent answers again');
});

test('it backs off restarts, then stops at three an hour', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });
  const recoveredAt: number[] = [];

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(true),
    recover: () => {
      recoveredAt.push(ctx.clock.nowMs);

      return Promise.resolve(true);
    },
    timeoutMs: 60_000,
    action: 'restart',
  });

  // silent for good: each restart's new agent goes silent too, and each
  // silence is two looks this far apart
  for (const ms of [60_000, 30_000, 30_000, 120_000, 200_000, 60_000]) {
    watchdog.observe(imp, false);

    ctx.clock.nowMs += ms;

    watchdog.observe(imp, false);

    await watchdog.settle();
  }

  // 60 s, then 60 s after the first, then 120 s after the second; none after
  expect(recoveredAt).toStrictEqual([60_000, 120_000, 240_000]);
  expect(ctx.logs.filter((line) => line.includes('it only reports now'))).toHaveLength(1);
});

test('it tries a restart another operation held off again at the next look', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });

  // the first try finds the imp's lock taken; the second gets it
  const recover = mock(() => Promise.resolve(true)).mockResolvedValueOnce(false);

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(true),
    recover,
    timeoutMs: 60_000,
    action: 'restart',
  });

  watchdog.observe(imp, false);

  ctx.clock.nowMs = 60_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  ctx.clock.nowMs = 62_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  expect(recover).toHaveBeenCalledTimes(2);
});

test('it starts the silence of an imp that is held or gone over', async () => {
  const ctx = setupTest();
  const imp = buildMockImpRecord({ name: 'dev' });

  const watchdog = createAgentWatchdog({
    ...ctx.deps,
    confirmSilent: () => Promise.resolve(true),
    recover: () => Promise.resolve(true),
    timeoutMs: 60_000,
    action: 'report',
  });

  watchdog.observe(imp, false);

  ctx.clock.nowMs = 50_000;

  watchdog.forget(imp.id);
  watchdog.observe(imp, false);

  ctx.clock.nowMs = 70_000;

  watchdog.observe(imp, false);

  await watchdog.settle();

  expect(watchdog.readSilentSince(imp.id)).toBeNull();
  expect(ctx.logs).toStrictEqual([]);
});
