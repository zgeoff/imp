import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { buildStubClock } from '@impz/daemon/src/test-utils/build-stub-clock';
import { startStubSilentOrigin } from '@impz/daemon/src/test-utils/start-stub-silent-origin';
import { invariant } from '@impz/test-utils/invariant';
import { createImpClient } from './create-imp-client';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const origin = startStubSilentOrigin(stack, {
    controlPath: '/rpc/imps/list',
    answer: () => Response.json({ json: { ok: true } }),
  });

  const clock = buildStubClock();

  const client = createImpClient({
    url: origin.origin,
    token: 'root-token',
    startTimer: clock.startTimer,
  });

  return { stack, origin, clock, client };
}

test('#backups.run ends at its 24 hour deadline when impd sends no answer', async () => {
  const ctx = setupTest();
  const call = ctx.client.backups.run();

  await ctx.origin.longHeld;

  const pendingMs = ctx.clock.readPendingMs();

  ctx.clock.firePending();

  expect(pendingMs).toStrictEqual([86_400_000]);

  expect(call).rejects.toMatchObject({
    name: 'TimeoutError',
    message: 'impd sent no answer to backups.run in 24 hours',
  });

  await expect(ctx.origin.longGone).toResolve();
});

test('#backups.restore ends at its 24 hour deadline when impd sends no answer', async () => {
  const ctx = setupTest();
  const call = ctx.client.backups.restore({ name: 'dev' });

  await ctx.origin.longHeld;

  const pendingMs = ctx.clock.readPendingMs();

  ctx.clock.firePending();

  expect(pendingMs).toStrictEqual([86_400_000]);

  expect(call).rejects.toMatchObject({
    name: 'TimeoutError',
    message: 'impd sent no answer to backups.restore in 24 hours',
  });
});

test('#backups.check ends at its 24 hour deadline when impd sends no answer', async () => {
  const ctx = setupTest();
  const call = ctx.client.backups.check({});

  await ctx.origin.longHeld;

  const pendingMs = ctx.clock.readPendingMs();

  ctx.clock.firePending();

  expect(pendingMs).toStrictEqual([86_400_000]);

  expect(call).rejects.toMatchObject({
    name: 'TimeoutError',
    message: 'impd sent no answer to backups.check in 24 hours',
  });
});

test('#images.add ends at its 6 hour deadline when impd sends no answer', async () => {
  const ctx = setupTest();
  const call = ctx.client.images.add({ ref: 'busybox:1.37' });

  await ctx.origin.longHeld;

  const pendingMs = ctx.clock.readPendingMs();

  ctx.clock.firePending();

  expect(pendingMs).toStrictEqual([21_600_000]);

  expect(call).rejects.toMatchObject({
    name: 'TimeoutError',
    message: 'impd sent no answer to images.add in 6 hours',
  });
});

test('#images.build ends at its 6 hour deadline when impd sends no answer', async () => {
  const ctx = setupTest();
  const call = ctx.client.images.build({ contextDir: '/srv/app', name: 'app' });

  await ctx.origin.longHeld;

  const pendingMs = ctx.clock.readPendingMs();

  ctx.clock.firePending();

  expect(pendingMs).toStrictEqual([21_600_000]);

  expect(call).rejects.toMatchObject({
    name: 'TimeoutError',
    message: 'impd sent no answer to images.build in 6 hours',
  });
});

test('#system.gc ends at its one hour deadline when impd sends no answer', async () => {
  const ctx = setupTest();
  const call = ctx.client.system.gc({});

  await ctx.origin.longHeld;

  const pendingMs = ctx.clock.readPendingMs();

  ctx.clock.firePending();

  expect(pendingMs).toStrictEqual([3_600_000]);

  expect(call).rejects.toMatchObject({
    name: 'TimeoutError',
    message: 'impd sent no answer to system.gc in an hour',
  });
});

test('#moves.abort ends at its one hour deadline when impd sends no answer', async () => {
  const ctx = setupTest();
  const call = ctx.client.moves.abort({ name: 'dev' });

  await ctx.origin.longHeld;

  const pendingMs = ctx.clock.readPendingMs();

  ctx.clock.firePending();

  expect(pendingMs).toStrictEqual([3_600_000]);

  expect(call).rejects.toMatchObject({
    name: 'TimeoutError',
    message: 'impd sent no answer to moves.abort in an hour',
  });
});

test('#moves.resume ends at its one hour deadline when impd sends no answer', async () => {
  const ctx = setupTest();
  const call = ctx.client.moves.resume({ name: 'dev' });

  await ctx.origin.longHeld;

  const pendingMs = ctx.clock.readPendingMs();

  ctx.clock.firePending();

  expect(pendingMs).toStrictEqual([3_600_000]);

  expect(call).rejects.toMatchObject({
    name: 'TimeoutError',
    message: 'impd sent no answer to moves.resume in an hour',
  });
});

test('#backups.run hands on the answer that comes before its deadline, and stops the deadline', async () => {
  const ctx = setupTest();

  const control = new AbortController();

  // the control's end lets the origin answer
  const controlCall = fetch(`${ctx.origin.origin}/rpc/imps/list`, {
    method: 'POST',
    body: '{}',
    signal: control.signal,
  });

  const call = ctx.client.backups.run();

  await Promise.all([ctx.origin.controlHeld, ctx.origin.longHeld]);

  control.abort();

  await Promise.allSettled([controlCall]);

  // the stand-in's answer, not a run's shape
  const answer: unknown = await call;

  expect(answer).toStrictEqual({ ok: true });
  expect(ctx.clock.countPending()).toBe(0);
});

// a browser the SDK serves (Firefox 121–123) has no AbortSignal.any
test('#backups.run ends at its deadline in a runtime without AbortSignal.any', async () => {
  const ctx = setupTest();
  const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any');

  invariant(any);

  Reflect.deleteProperty(AbortSignal, 'any');

  onTestFinished(() => {
    Object.defineProperty(AbortSignal, 'any', any);
  });

  const call = ctx.client.backups.run();

  await ctx.origin.longHeld;

  ctx.clock.firePending();

  expect('any' in AbortSignal).toBe(false);

  expect(call).rejects.toMatchObject({
    name: 'TimeoutError',
    message: 'impd sent no answer to backups.run in 24 hours',
  });

  await expect(ctx.origin.longGone).toResolve();
});

test('#backups.run ends when its caller aborts in a runtime without AbortSignal.any', async () => {
  const ctx = setupTest();
  const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any');

  invariant(any);

  Reflect.deleteProperty(AbortSignal, 'any');

  onTestFinished(() => {
    Object.defineProperty(AbortSignal, 'any', any);
  });

  const caller = new AbortController();

  const call = ctx.client.backups.run(undefined, { signal: caller.signal });

  await ctx.origin.longHeld;

  caller.abort();

  expect(call).rejects.toMatchObject({ name: 'AbortError' });

  await expect(ctx.origin.longGone).toResolve();
});

test('#backups.run throws the error of a transport that throws at once, and stops its deadline', async () => {
  const clock = buildStubClock();

  const client = createImpClient({
    url: 'http://impd.test',
    token: 'root-token',
    startTimer: clock.startTimer,
    fetch: () => {
      throw new Error('no transport');
    },
  });

  const call = client.backups.run();

  await expect(call).rejects.toThrowWithMessage(Error, 'no transport');

  expect(clock.countPending()).toBe(0);
});

test('#imps.list starts no deadline of its own', async () => {
  const ctx = setupTest();

  const caller = new AbortController();

  const call = ctx.client.imps.list(undefined, { signal: caller.signal });

  await ctx.origin.controlHeld;

  const pending = ctx.clock.countPending();

  caller.abort();

  expect(pending).toBe(0);
  expect(call).rejects.toThrow();
});

// Bun reads its fetch idle limit (360 s by default) only at startup, so a
// child Bun runs with 1 s; its imps.list is the control that the limit
// expires, after about 8 s on Bun 1.4.2
test('#backups.run gets an answer that stays silent past Bun’s idle limit, where imps.list gives up', async () => {
  const ctx = setupTest();

  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'test-utils/run-idle-limited-calls.ts'),
      JSON.stringify({ url: ctx.origin.origin }),
    ],
    {
      env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1' },
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );

  // the child goes first, before the origin it calls
  ctx.stack.defer(() => {
    child.kill();
  });

  const output = await new Response(child.stdout).text();

  const lines = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);

  expect(lines).toIncludeSameMembers([
    { kind: 'imps.list', isOk: false, error: 'TimeoutError' },
    { kind: 'backups.run', isOk: true, answer: { ok: true } },
  ]);
}, 30_000);
