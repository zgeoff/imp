import { expect, mock, test } from 'bun:test';
import { buildStubTimers } from './build-stub-timers';

test('it holds a started timer pending without firing it', () => {
  const timers = buildStubTimers();
  const fire = mock((): void => {});

  timers.startTimer(fire, 500);

  expect(timers.readPendingMs()).toStrictEqual([500]);
  expect(fire).not.toHaveBeenCalled();
});

test('it fires each pending timer once, in the order they started', () => {
  const timers = buildStubTimers();
  const fired: string[] = [];

  timers.startTimer(() => {
    fired.push('first');
  }, 500);

  timers.startTimer(() => {
    fired.push('second');
  }, 100);

  timers.firePending();
  timers.firePending();

  expect(fired).toStrictEqual(['first', 'second']);
  expect(timers.readPendingMs()).toStrictEqual([]);
});

test('it never fires a cancelled timer', () => {
  const timers = buildStubTimers();
  const fire = mock((): void => {});
  const cancel = timers.startTimer(fire, 500);

  cancel();

  timers.firePending();

  expect(fire).not.toHaveBeenCalled();
  expect(timers.readPendingMs()).toStrictEqual([]);
});

test('it leaves a timer that a fire starts pending until the next fire', () => {
  const timers = buildStubTimers();
  const fire = mock((): void => {});

  timers.startTimer(() => {
    timers.startTimer(fire, 200);
  }, 100);

  timers.firePending();

  expect(fire).not.toHaveBeenCalled();
  expect(timers.readPendingMs()).toStrictEqual([200]);
});
