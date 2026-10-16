import { expect, onTestFinished, test } from 'bun:test';
import { startStubSilentOrigin } from './start-stub-silent-origin';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return { stack };
}

test('it answers the long path once the control’s client has given up', async () => {
  const ctx = setupTest();
  const origin = startStubSilentOrigin(ctx.stack);

  const control = new AbortController();

  const controlCall = fetch(`${origin.origin}/control`, {
    method: 'POST',
    body: 'the control call',
    signal: control.signal,
  });

  const longCall = fetch(`${origin.origin}/long`, { method: 'POST', body: 'the long call' });

  await Promise.all([origin.controlHeld, origin.longHeld]);

  control.abort();

  expect(controlCall).rejects.toThrow();

  await origin.controlGone;

  const response = await longCall;
  const text = await response.text();

  expect(text).toBe('the long answer');
});

test('it holds the control path it is given, and answers another path with its answer', async () => {
  const ctx = setupTest();

  const origin = startStubSilentOrigin(ctx.stack, {
    controlPath: '/rpc/imps/list',
    answer: () => Response.json({ json: { ok: true } }),
  });

  const control = new AbortController();

  const controlCall = fetch(`${origin.origin}/rpc/imps/list`, {
    method: 'POST',
    body: '{}',
    signal: control.signal,
  });

  const longCall = fetch(`${origin.origin}/rpc/backups/run`, { method: 'POST', body: '{}' });

  await Promise.all([origin.controlHeld, origin.longHeld]);

  control.abort();

  await Promise.allSettled([controlCall]);

  const response = await longCall;
  const answer: unknown = await response.json();

  expect(answer).toStrictEqual({ json: { ok: true } });
});

test('it marks the long path gone when its client gives up', async () => {
  const ctx = setupTest();
  const origin = startStubSilentOrigin(ctx.stack);

  const client = new AbortController();

  const longCall = fetch(`${origin.origin}/long`, {
    method: 'POST',
    body: 'the long call',
    signal: client.signal,
  });

  await origin.longHeld;

  client.abort();

  expect(longCall).rejects.toThrow();

  await expect(origin.longGone).toResolve();
});
