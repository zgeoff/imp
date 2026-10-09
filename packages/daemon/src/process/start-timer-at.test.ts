import { expect, test } from 'bun:test';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { startTimerAt } from './start-timer-at';

test('it does not fire before a time 30 days off', () => {
  const clock = buildStubClock();
  const fired: number[] = [];

  startTimerAt(
    () => {
      fired.push(clock.now());
    },
    30 * 86_400_000,
    { now: clock.now, startTimer: clock.startTimer },
  );

  clock.runFor(30 * 86_400_000 - 1);

  expect(fired).toStrictEqual([]);
});

test('it fires once at a time 30 days off', () => {
  const clock = buildStubClock();
  const fired: number[] = [];

  startTimerAt(
    () => {
      fired.push(clock.now());
    },
    30 * 86_400_000,
    { now: clock.now, startTimer: clock.startTimer },
  );

  clock.runFor(31 * 86_400_000);

  expect(fired).toStrictEqual([30 * 86_400_000]);
});

test('it waits for a far time in steps no longer than setTimeout can take', () => {
  const clock = buildStubClock();

  startTimerAt(() => {}, 30 * 86_400_000, { now: clock.now, startTimer: clock.startTimer });

  clock.runFor(30 * 86_400_000);

  expect(clock.delays).toSatisfyAll((ms: number) => ms <= 2 ** 31 - 1);
});

test('it never fires once cancelled between steps', () => {
  const clock = buildStubClock();
  const fired: number[] = [];

  const cancel = startTimerAt(
    () => {
      fired.push(clock.now());
    },
    30 * 86_400_000,
    { now: clock.now, startTimer: clock.startTimer },
  );

  clock.runFor(26 * 86_400_000);

  cancel();

  clock.runFor(10 * 86_400_000);

  expect(fired).toStrictEqual([]);
});

test.each([
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
])('it fires at once for a time of %s', (_label, at) => {
  const clock = buildStubClock();
  const fired: number[] = [];

  startTimerAt(
    () => {
      fired.push(clock.now());
    },
    at,
    { now: clock.now, startTimer: clock.startTimer },
  );

  clock.runFor(0);

  expect(fired).toStrictEqual([0]);
});
