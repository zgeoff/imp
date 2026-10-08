import { expect, test } from 'bun:test';
import { waitFor } from './wait-for';

// A clock that starts at zero and moves only when the wait waits out an
// interval, so a deadline passes after a known number of attempts.
function setupTest() {
  const waits: number[] = [];
  let elapsed = 0;

  return {
    waits,
    now: () => elapsed,
    wait: (ms: number) => {
      waits.push(ms);

      elapsed += ms;

      return Promise.resolve();
    },
  };
}

test('it resolves with the value of an attempt that succeeds at once', async () => {
  const value = await waitFor(() => 42);

  expect(value).toBe(42);
});

test('it retries until the attempt stops throwing and resolves with its value', async () => {
  const ctx = setupTest();
  let attempts = 0;

  const value = await waitFor(
    () => {
      attempts++;

      if (attempts < 3) {
        throw new Error('not ready yet');
      }

      return 'done';
    },
    { now: ctx.now, wait: ctx.wait },
  );

  expect(value).toBe('done');
  expect(attempts).toBe(3);
});

test('it waits the given interval between attempts', async () => {
  const ctx = setupTest();
  let attempts = 0;

  await waitFor(
    () => {
      attempts++;

      if (attempts < 3) {
        throw new Error('not ready yet');
      }
    },
    { intervalMs: 15, now: ctx.now, wait: ctx.wait },
  );

  expect(ctx.waits).toStrictEqual([15, 15]);
});

test('it retries an attempt that rejects', async () => {
  const ctx = setupTest();
  let attempts = 0;

  const value = await waitFor(
    () => {
      attempts++;

      if (attempts < 2) {
        return Promise.reject(new Error('not ready yet'));
      }

      return Promise.resolve('done');
    },
    { now: ctx.now, wait: ctx.wait },
  );

  expect(value).toBe('done');
});

test('it rethrows the last failure of the attempt once the deadline passes', () => {
  const ctx = setupTest();
  let attempts = 0;

  const waiting = waitFor(
    () => {
      attempts++;
      throw new Error(`attempt ${attempts} failed`);
    },
    { intervalMs: 10, timeoutMs: 30, now: ctx.now, wait: ctx.wait },
  );

  expect(waiting).rejects.toThrowWithMessage(Error, 'attempt 4 failed');
});
