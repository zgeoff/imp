import { expect, test } from 'bun:test';
import { readErrorMessage } from '../../read-error-message';
import { readRejection } from '../../read-rejection';
import { waitForTxt } from './wait-for-txt';

function resolveServer(name: string): Promise<readonly string[]> {
  return Promise.resolve([name]);
}

test('it waits until every nameserver has every value', async () => {
  const answers = new Map<string, string[]>([
    ['ns1', ['a']],
    ['ns2', []],
  ]);

  let rounds = 0;

  await waitForTxt(['ns1', 'ns2'], '_acme-challenge.x', ['a', 'b'], {
    intervalMs: 1,
    resolveServer,
    readTxt: (server) => {
      rounds += 1;

      // both values arrive on both servers after a few rounds
      if (rounds > 4) {
        answers.set('ns1', ['a', 'b']);
        answers.set('ns2', ['b', 'a', 'stale']);
      }

      return Promise.resolve(answers.get(server) ?? []);
    },
  });

  expect(rounds).toBeGreaterThan(4);
});

test('it names the nameserver that still lacks a value when time runs out', async () => {
  const waiting = waitForTxt(['ns1', 'ns2'], '_acme-challenge.x', ['a'], {
    timeoutMs: 20,
    intervalMs: 5,
    resolveServer,
    readTxt: (server) =>
      server === 'ns2' ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(['a']),
  });

  const error = await readRejection(waiting);

  expect(readErrorMessage(error)).toContain('did not reach nameserver ns2');
});

test('nameservers with no address are an error at once', async () => {
  const waiting = waitForTxt(['ns1'], '_acme-challenge.x', ['a'], {
    resolveServer: () => Promise.resolve([]),
    readTxt: () => Promise.resolve(['a']),
  });

  const error = await readRejection(waiting);

  expect(readErrorMessage(error)).toContain('no address for the nameservers');
});
