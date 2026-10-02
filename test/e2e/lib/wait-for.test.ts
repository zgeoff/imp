import { expect, test } from 'bun:test';
import { readRejection } from './read-rejection';
import { waitFor } from './wait-for';

test('it returns the value of an attempt that succeeds at once', async () => {
  const value = await waitFor('the answer', () => 42);

  expect(value).toBe(42);
});

test('it retries until the attempt stops throwing and resolves with its value', async () => {
  let ready = false;

  setTimeout(() => {
    ready = true;
  }, 60);

  const value = await waitFor(
    'readiness',
    () => {
      if (!ready) {
        throw new Error('not ready yet');
      }

      return 'done';
    },
    { intervalMs: 10 },
  );

  expect(value).toBe('done');
});

test('it names what it waited for and the last failure once the deadline passes', async () => {
  let attempts = 0;

  const wait = waitFor(
    'the flaky thing',
    () => {
      attempts++;
      throw new Error(`attempt ${String(attempts)} failed`);
    },
    { intervalMs: 10, timeoutMs: 80 },
  );

  const error = await readRejection(wait);

  expect(error).toBeInstanceOf(Error);

  expect(String(error)).toMatch(
    /^Error: timed out after 80 ms waiting for the flaky thing: attempt \d+ failed$/,
  );
});
