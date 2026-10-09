import { expect, test } from 'bun:test';
import { buildStubClock } from './build-stub-clock';

test('it starts at 0 and moves only with runFor', () => {
  const clock = buildStubClock();

  clock.runFor(1500);

  expect(clock.now()).toBe(1500);
});

test('it starts at the time it is given', () => {
  const clock = buildStubClock({ startMs: 1_700_000_000_000 });

  clock.runFor(1500);

  expect(clock.now()).toBe(1_700_000_001_500);
});

test('it fires no timer before its time', () => {
  const clock = buildStubClock();
  const fired: number[] = [];

  clock.startTimer(() => {
    fired.push(clock.now());
  }, 100);

  clock.runFor(99);

  expect(fired).toStrictEqual([]);
});

test('it fires timers in time order with the clock at each time', () => {
  const clock = buildStubClock();
  const fired: string[] = [];

  clock.startTimer(() => {
    fired.push(`late ${String(clock.now())}`);
  }, 200);

  clock.startTimer(() => {
    fired.push(`early ${String(clock.now())}`);
  }, 100);

  clock.runFor(300);

  expect(fired).toStrictEqual(['early 100', 'late 200']);
});

test('it fires a timer that a timer starts within the same run', () => {
  const clock = buildStubClock();
  const fired: number[] = [];

  clock.startTimer(() => {
    clock.startTimer(() => {
      fired.push(clock.now());
    }, 50);
  }, 100);

  clock.runFor(200);

  expect(fired).toStrictEqual([150]);
});

test('it never fires a cancelled timer', () => {
  const clock = buildStubClock();
  const fired: number[] = [];

  const cancel = clock.startTimer(() => {
    fired.push(clock.now());
  }, 100);

  cancel();

  clock.runFor(200);

  expect(fired).toStrictEqual([]);
});

test('it moves the clock by the length of a sleep and records it', async () => {
  const clock = buildStubClock();

  await clock.sleep(50);

  expect(clock.now()).toBe(50);
  expect(clock.sleeps).toStrictEqual([50]);
});

test('it fires the timers a sleep passes', async () => {
  const clock = buildStubClock();
  const fired: number[] = [];

  clock.startTimer(() => {
    fired.push(clock.now());
  }, 30);

  await clock.sleep(50);

  expect(fired).toStrictEqual([30]);
});

test('it records the delay of each timer it starts', () => {
  const clock = buildStubClock();

  clock.startTimer(() => {}, 100);
  clock.startTimer(() => {}, 0);

  expect(clock.delays).toStrictEqual([100, 0]);
});
