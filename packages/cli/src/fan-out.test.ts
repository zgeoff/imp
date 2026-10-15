import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORPCError } from '@impz/client';
import { invariant } from '@impz/test-utils/invariant';
import { waitFor } from '@impz/test-utils/wait-for';
import { listSavedTargets, runOnHosts } from './fan-out';
import { writeHostConfig } from './host-store';
import { buildMockSavedTarget } from './test-utils/build-mock-saved-target';
import { buildStubTimeouts } from './test-utils/build-stub-timeouts';
import { UsageError } from './usage-error';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fan-out-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // where config.json keeps the saved hosts
  return { env: { XDG_CONFIG_HOME: dir } };
}

test('#runOnHosts gives each host its own answer or error, and a silent one the timeout', async () => {
  const signals: AbortSignal[] = [];
  const timeouts = buildStubTimeouts();

  const replies = [
    () => Promise.resolve('imps'),

    // never answers, and never watches the signal
    () => new Promise<string>(() => {}),
    () => Promise.reject(new ORPCError('UNAUTHORIZED', { status: 401 })),
  ];

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
    timeouts.startTimer,
  );

  // box and old settle on their own; then the silent host's timer runs out
  await waitFor(() => {
    expect(timeouts.timers.map((timer) => timer.state)).toStrictEqual([
      'cancelled',
      'pending',
      'cancelled',
    ]);
  });

  timeouts.firePending();

  const settled = await answers;

  expect(settled).toStrictEqual([
    { host: 'box', value: 'imps' },
    { host: 'laptop', error: 'no answer in 0.05 s' },
    {
      host: 'old',
      error:
        'unauthorized: old (http://old:7070) refused the token; run impz login http://old:7070 --name old',
    },
  ]);
});

test('#runOnHosts gives each host a timer of the timeout, cancelled once it answers', async () => {
  const timeouts = buildStubTimeouts();

  await runOnHosts(
    [buildMockSavedTarget()],
    () => Promise.resolve('imps'),
    50,
    timeouts.startTimer,
  );

  expect(timeouts.timers).toStrictEqual([{ ms: 50, state: 'cancelled' }]);
});

test('#runOnHosts aborts each host’s requests once its answer is in, the silent one’s by the timeout', async () => {
  const signals: AbortSignal[] = [];
  const timeouts = buildStubTimeouts();

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
    timeouts.startTimer,
  );

  await waitFor(() => {
    expect(signals.filter((signal) => signal.aborted)).toHaveLength(2);
  });

  timeouts.firePending();

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
  const ctx = setupTest();

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
  const ctx = setupTest();

  expect(() => listSavedTargets(ctx.env)).toThrowWithMessage(
    UsageError,
    'no saved hosts (see impz login)',
  );
});
