import { expect, mock, test } from 'bun:test';
import { waitForTxt } from './wait-for-txt';

test('it resolves once every nameserver has every value, waiting the interval between rounds', async () => {
  const answers: Record<string, string[][]> = {
    ns1: [['a'], ['a', 'b']],
    ns2: [['b', 'a', 'stale']],
  };

  const wait = mock<(ms: number) => Promise<void>>(() => Promise.resolve());

  await waitForTxt(['ns1', 'ns2'], '_acme-challenge.x', ['a', 'b'], {
    intervalMs: 5000,
    wait,
    resolveServer: (name) => Promise.resolve([name]),
    readTxt: (server) => Promise.resolve(answers[server]?.shift() ?? []),
  });

  expect(wait.mock.calls).toStrictEqual([[5000]]);
});

test('it asks every address of every nameserver', async () => {
  const asked: string[] = [];

  const addresses: Record<string, string[]> = {
    'ns1.test': ['192.0.2.1', '192.0.2.2'],
    'ns2.test': ['192.0.2.3'],
  };

  await waitForTxt(['ns1.test', 'ns2.test'], '_acme-challenge.x', ['a'], {
    resolveServer: (name) => Promise.resolve(addresses[name] ?? []),
    readTxt: (server, fqdn) => {
      asked.push(`${server} ${fqdn}`);

      return Promise.resolve(['a']);
    },
  });

  expect(asked).toStrictEqual([
    '192.0.2.1 _acme-challenge.x',
    '192.0.2.2 _acme-challenge.x',
    '192.0.2.3 _acme-challenge.x',
  ]);
});

test('it counts a failed lookup as missing and resolves once the value answers', async () => {
  const answers = [() => Promise.reject(new Error('ENOTFOUND')), () => Promise.resolve(['a'])];
  const wait = mock<(ms: number) => Promise<void>>(() => Promise.resolve());

  await waitForTxt(['ns1'], '_acme-challenge.x', ['a'], {
    wait,
    resolveServer: (name) => Promise.resolve([name]),
    readTxt: () => (answers.shift() ?? (() => Promise.resolve([])))(),
  });

  expect(wait).toHaveBeenCalledOnce();
});

test('it names the nameserver that still lacks a value when time runs out', () => {
  const clock = { now: 0 };

  const waiting = waitForTxt(['ns1', 'ns2'], '_acme-challenge.x', ['a'], {
    timeoutMs: 20_000,
    intervalMs: 5000,
    now: () => clock.now,
    wait: (ms) => {
      clock.now += ms;

      return Promise.resolve();
    },
    resolveServer: (name) => Promise.resolve([name]),
    readTxt: (server) =>
      server === 'ns2' ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(['a']),
  });

  expect(waiting).rejects.toThrowWithMessage(
    Error,
    'the TXT record _acme-challenge.x did not reach nameserver ns2 within 20s',
  );
});

test('it gives up at the deadline and not before', async () => {
  const clock = { now: 0 };
  const rounds: number[] = [];

  const waiting = waitForTxt(['ns1'], '_acme-challenge.x', ['a'], {
    timeoutMs: 20_000,
    intervalMs: 5000,
    now: () => clock.now,
    wait: (ms) => {
      clock.now += ms;

      return Promise.resolve();
    },
    resolveServer: (name) => Promise.resolve([name]),
    readTxt: () => {
      rounds.push(clock.now);

      return Promise.resolve([]);
    },
  });

  await expect(waiting).toReject();

  expect(rounds).toStrictEqual([0, 5000, 10_000, 15_000, 20_000]);
});

test('it rejects at once when the nameservers have no address', () => {
  const waiting = waitForTxt(['ns1', 'ns2'], '_acme-challenge.x', ['a'], {
    resolveServer: () => Promise.resolve([]),
    readTxt: () => Promise.resolve(['a']),
  });

  expect(waiting).rejects.toThrowWithMessage(
    Error,
    'no address for the nameservers of _acme-challenge.x: ns1, ns2',
  );
});
