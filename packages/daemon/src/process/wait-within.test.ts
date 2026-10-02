import { expect, test } from 'bun:test';
import { readErrorMessage } from '../read-error-message';
import { readRejection } from '../read-rejection';
import { waitWithin } from './wait-within';

test('it reports whether the promise settled in time and passes a rejection on', async () => {
  const quick = await waitWithin(Promise.resolve(), 50);
  const slow = await waitWithin(Bun.sleep(200), 10);

  const failed = waitWithin(Promise.reject(new Error('boom')), 50);

  expect([quick, slow]).toEqual([true, false]);

  const error = await readRejection(failed);

  expect(readErrorMessage(error)).toBe('boom');
});
