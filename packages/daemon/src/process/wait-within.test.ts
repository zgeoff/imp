import { expect, test } from 'bun:test';
import { waitWithin } from './wait-within';

test('it resolves true for a promise that settles within the time', async () => {
  const isSettled = await waitWithin(Promise.resolve(), 50);

  expect(isSettled).toBeTrue();
});

test('it resolves false for a promise still pending at the deadline', async () => {
  const isSettled = await waitWithin(new Promise(() => {}), 1);

  expect(isSettled).toBeFalse();
});

test('it passes the rejection of the promise on', () => {
  const failed = Promise.reject(new Error('boom'));

  expect(waitWithin(failed, 50)).rejects.toThrowWithMessage(Error, 'boom');
});
