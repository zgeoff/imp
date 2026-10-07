import { expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { ORPCError } from '@orpc/client';
import { listSavedTargets, runOnHosts } from './fan-out';
import { writeHostConfig } from './host-store';
import { buildMockSavedTarget } from './test-utils/build-mock-saved-target';
import { UsageError } from './usage-error';

function setupTest() {
  using stack = new DisposableStack();

  const dir = mkdtempSync(join(tmpdir(), 'imp-fan-out-'));

  stack.defer(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const owned = stack.move();

  return {
    env: { XDG_CONFIG_HOME: dir },
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('#runOnHosts gives each host its own answer or error, and a silent one the timeout', async () => {
  const signals: AbortSignal[] = [];
  const timers: { readonly fire: () => void; isCancelled: boolean }[] = [];

  const replies = [
    () => Promise.resolve('imps'),

    // never answers, and never watches the signal
    () => new Promise<string>(() => {}),
    () => Promise.reject(new ORPCError('UNAUTHORIZED', { status: 401 })),
  ];

  const startTimer = mock((_ms: number, fire: () => void) => {
    const timer = { fire, isCancelled: false };

    timers.push(timer);

    return () => {
      timer.isCancelled = true;
    };
  });

  const answers = runOnHosts(
    [
      buildMockSavedTarget({ host: 'box' }),
      buildMockSavedTarget({ host: 'laptop' }),
      buildMockSavedTarget({ host: 'old', config: { url: 'http://old:7070' } }),
    ],
    (_client, signal) => {
      signals.push(signal);

      const reply = replies.shift();

      invariant(reply);

      return reply();
    },
    50,
    startTimer,
  );

  // box and old settle on their own; then the silent host's timer runs out
  await waitFor(() => {
    expect(timers.filter((timer) => timer.isCancelled)).toHaveLength(2);
  });

  timers.find((timer) => !timer.isCancelled)?.fire();

  const settled = await answers;

  expect(settled).toStrictEqual([
    { host: 'box', value: 'imps' },
    { host: 'laptop', error: 'no answer in 0.05 s' },
    {
      host: 'old',
      error:
        'unauthorized: old (http://old:7070) refused the token; run imp login http://old:7070 --name old',
    },
  ]);
});

test('#runOnHosts gives each host a timer of the timeout', async () => {
  const startTimer = mock<(ms: number, fire: () => void) => () => void>(() => () => {});

  await runOnHosts([buildMockSavedTarget()], () => Promise.resolve('imps'), 50, startTimer);

  expect(startTimer).toHaveBeenCalledExactlyOnceWith(50, expect.any(Function));
});

test('#runOnHosts aborts each host’s requests once its answer is in, the silent one’s by the timeout', async () => {
  const signals: AbortSignal[] = [];
  const fires: (() => void)[] = [];

  const replies = [
    () => Promise.resolve('imps'),
    () => new Promise<string>(() => {}),
    () => Promise.reject(new Error('no such procedure')),
  ];

  const answers = runOnHosts(
    [buildMockSavedTarget(), buildMockSavedTarget(), buildMockSavedTarget()],
    (_client, signal) => {
      signals.push(signal);

      const reply = replies.shift();

      invariant(reply);

      return reply();
    },
    50,
    (_ms, fire) => {
      fires.push(fire);

      return () => {};
    },
  );

  await waitFor(() => {
    expect(signals.filter((signal) => signal.aborted)).toHaveLength(2);
  });

  fires[1]?.();

  await answers;

  expect(signals).toSatisfyAll((signal: AbortSignal) => signal.aborted);
});

test('#runOnHosts waits on the real clock when no timer is passed', async () => {
  const answers = await runOnHosts(
    [buildMockSavedTarget({ host: 'laptop' })],
    () => new Promise<string>(() => {}),
    1,
  );

  expect(answers).toStrictEqual([{ host: 'laptop', error: 'no answer in 0.001 s' }]);
});

test('#runOnHosts aborts the requests still open beside a call that fails', async () => {
  const signals: AbortSignal[] = [];

  const answers = await runOnHosts([buildMockSavedTarget({ host: 'box' })], (_client, signal) => {
    signals.push(signal);

    // one request rejects at once while the other never settles
    return Promise.all([
      Promise.reject(new Error('no such procedure')),
      new Promise<never>(() => {}),
    ]);
  });

  expect(answers).toStrictEqual([{ host: 'box', error: 'no such procedure' }]);
  expect(signals).toSatisfyAll((signal: AbortSignal) => signal.aborted);
});

test('#listSavedTargets lists the saved hosts in name order', () => {
  using ctx = setupTest();

  writeHostConfig(ctx.env, {
    current: 'zeta',
    hosts: {
      zeta: { url: 'http://zeta:7070', token: 'z' },
      alpha: { url: 'http://alpha:7070', token: null },
    },
  });

  expect(listSavedTargets(ctx.env)).toStrictEqual([
    { host: 'alpha', config: { url: 'http://alpha:7070', token: null, host: 'alpha' } },
    { host: 'zeta', config: { url: 'http://zeta:7070', token: 'z', host: 'zeta' } },
  ]);
});

test('#listSavedTargets rejects a config with no saved hosts', () => {
  using ctx = setupTest();

  expect(() => listSavedTargets(ctx.env)).toThrowWithMessage(
    UsageError,
    'no saved hosts (see imp login)',
  );
});
