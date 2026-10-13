import { expect, test } from 'bun:test';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { requireWithin } from './require-within';

test('it resolves with the value of a promise that settles within the time', async () => {
  const clock = buildStubClock();

  const value = await requireWithin(
    Promise.resolve(5),
    50,
    () => new Error('late'),
    clock.startTimer,
  );

  expect(value).toBe(5);
});

test('it throws the built error for a promise still pending at the deadline', () => {
  const clock = buildStubClock();

  const waiting = requireWithin(
    new Promise(() => {}),
    50,
    () => new Error('late'),
    clock.startTimer,
  );

  clock.runFor(50);

  expect(waiting).rejects.toThrowWithMessage(Error, 'late');
});

test('it passes the rejection of the promise on', () => {
  const clock = buildStubClock();

  const waiting = requireWithin(
    Promise.reject(new Error('boom')),
    50,
    () => new Error('late'),
    clock.startTimer,
  );

  expect(waiting).rejects.toThrowWithMessage(Error, 'boom');
});

test('it cancels its timer once the promise settles', async () => {
  const clock = buildStubClock();

  await requireWithin(Promise.resolve(), 50, () => new Error('late'), clock.startTimer);

  expect(clock.countPending()).toBe(0);
});

test('it times out on a real timer by default', () => {
  const waiting = requireWithin(new Promise(() => {}), 1, () => new Error('late'));

  expect(waiting).rejects.toThrowWithMessage(Error, 'late');
});
