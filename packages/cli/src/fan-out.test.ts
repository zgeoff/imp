import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORPCError } from '@orpc/client';
import { listSavedTargets, runOnHosts } from './fan-out';
import type { SavedTarget } from './fan-out';
import { writeHostConfig } from './host-store';

function buildTarget(host: string): SavedTarget {
  return { host, config: { url: `http://${host}:7070`, token: 'secret', host } };
}

test('each host answers or fails alone, and a silent one costs the timeout', async () => {
  const signals: AbortSignal[] = [];
  const started = performance.now();

  const answers = await runOnHosts(
    [buildTarget('box'), buildTarget('laptop'), buildTarget('old')],
    (_client, signal) => {
      signals.push(signal);

      const host = signals.length;

      if (host === 1) {
        return Promise.resolve('imps');
      }

      if (host === 2) {
        // never answers, and never watches the signal
        return new Promise<string>(() => {});
      }

      return Promise.reject(new ORPCError('UNAUTHORIZED', { status: 401 }));
    },
    50,
  );

  expect(performance.now() - started).toBeLessThan(1000);

  expect(answers).toEqual([
    { host: 'box', value: 'imps' },
    { host: 'laptop', error: 'no answer in 0.05 s' },
    {
      host: 'old',
      error:
        'unauthorized: old (http://old:7070) refused the token; run imp login http://old:7070 --name old',
    },
  ]);

  // the requests of the host that ran out of time are aborted
  expect(signals.map((signal) => signal.aborted)).toEqual([false, true, false]);
});

test('the saved hosts come in name order, and none at all is a usage error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-fan-out-'));
  const env = { XDG_CONFIG_HOME: dir };

  try {
    expect(() => listSavedTargets(env)).toThrow('no saved hosts (see imp login)');

    writeHostConfig(env, {
      current: 'zeta',
      hosts: {
        zeta: { url: 'http://zeta:7070', token: 'z' },
        alpha: { url: 'http://alpha:7070', token: null },
      },
    });

    expect(listSavedTargets(env)).toEqual([
      { host: 'alpha', config: { url: 'http://alpha:7070', token: null, host: 'alpha' } },
      { host: 'zeta', config: { url: 'http://zeta:7070', token: 'z', host: 'zeta' } },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
