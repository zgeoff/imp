import { expect, test } from 'bun:test';
import { waitFor } from './wait-for';

test('it resolves with the value of an attempt that succeeds at once', async () => {
  const value = await waitFor('the answer', () => 42);

  expect(value).toBe(42);
});

test('it retries until the attempt stops throwing and resolves with its value', async () => {
  let attempts = 0;

  const value = await waitFor(
    'readiness',
    () => {
      attempts += 1;

      if (attempts < 3) {
        throw new Error('not ready yet');
      }

      return 'done';
    },
    { wait: () => Promise.resolve() },
  );

  expect(value).toBe('done');
});

test('it waits the interval between retries', async () => {
  let attempts = 0;
  const waits: number[] = [];

  await waitFor(
    'readiness',
    () => {
      attempts += 1;

      if (attempts < 3) {
        throw new Error('not ready yet');
      }
    },
    {
      intervalMs: 25,
      wait: (ms) => {
        waits.push(ms);

        return Promise.resolve();
      },
    },
  );

  expect(waits).toStrictEqual([25, 25]);
});

test('it names what it waited for and the last failure once the deadline passes', () => {
  // each retry moves the clock on by its interval, so the fourth attempt is
  // the first at the deadline
  const clock = { nowMs: 1000 };
  let attempts = 0;

  const pending = waitFor(
    'the flaky thing',
    () => {
      attempts += 1;
      throw new Error(`attempt ${String(attempts)} failed`);
    },
    {
      intervalMs: 20,
      timeoutMs: 60,
      now: () => clock.nowMs,
      wait: (ms) => {
        clock.nowMs += ms;

        return Promise.resolve();
      },
    },
  );

  expect(pending).rejects.toThrowWithMessage(
    Error,
    'timed out after 60 ms waiting for the flaky thing: attempt 4 failed',
  );
});
