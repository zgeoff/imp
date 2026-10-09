import { expect, mock, test } from 'bun:test';
import { buildStubTimer } from './build-stub-timer';

test('it reads the start time until the test advances the clock', () => {
  const timer = buildStubTimer(1000);

  timer.advance(250);

  expect(timer.now()).toBe(1250);
});

test('it holds a timer before its due time', () => {
  const timer = buildStubTimer();
  const run = mock<() => void>();

  timer.schedule(run, 100);
  timer.advance(99);

  expect(run).not.toHaveBeenCalled();
});

test('it runs a timer once its due time comes', () => {
  const timer = buildStubTimer();
  const run = mock<() => void>();

  timer.schedule(run, 100);
  timer.advance(99);
  timer.advance(1);

  expect(run).toHaveBeenCalledOnce();
});

test('it runs a due timer only once', () => {
  const timer = buildStubTimer();
  const run = mock<() => void>();

  timer.schedule(run, 10);
  timer.advance(10);
  timer.advance(10);

  expect(run).toHaveBeenCalledOnce();
});

test('it never runs a cancelled timer', () => {
  const timer = buildStubTimer();
  const run = mock<() => void>();
  const cancel = timer.schedule(run, 10);

  cancel();

  timer.advance(20);

  expect(run).not.toHaveBeenCalled();
  expect(timer.countPending()).toBe(0);
});

test('it runs the timers due in one advance in the order of their due times', () => {
  const timer = buildStubTimer();
  const order: string[] = [];

  timer.schedule(() => {
    order.push('late');
  }, 30);

  timer.schedule(() => {
    order.push('early');
  }, 10);

  timer.advance(30);

  expect(order).toStrictEqual(['early', 'late']);
});

test('it counts the timers that have not run yet', () => {
  const timer = buildStubTimer();

  timer.schedule(() => {}, 10);
  timer.schedule(() => {}, 30);
  timer.advance(10);

  expect(timer.countPending()).toBe(1);
});
