import { expect, mock, test } from 'bun:test';
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

test('it fires each pending timer by hand once, in the order they started', () => {
  const clock = buildStubClock();
  const fired: string[] = [];

  clock.startTimer(() => {
    fired.push('first');
  }, 500);

  clock.startTimer(() => {
    fired.push('second');
  }, 100);

  clock.firePending();
  clock.firePending();

  expect(fired).toStrictEqual(['first', 'second']);
  expect(clock.readPendingMs()).toStrictEqual([]);
});

test('it leaves the time where it is when it fires timers by hand', () => {
  const clock = buildStubClock();

  clock.startTimer(() => {}, 500);
  clock.firePending();

  expect(clock.now()).toBe(0);
});

test('it never fires a cancelled timer by hand', () => {
  const clock = buildStubClock();
  const fire = mock((): void => {});
  const cancel = clock.startTimer(fire, 500);

  cancel();

  clock.firePending();

  expect(fire).not.toHaveBeenCalled();
});

test('it leaves a timer that a fire by hand starts pending until the next fire', () => {
  const clock = buildStubClock();
  const fire = mock((): void => {});

  clock.startTimer(() => {
    clock.startTimer(fire, 200);
  }, 100);

  clock.firePending();

  expect(fire).not.toHaveBeenCalled();
  expect(clock.readPendingMs()).toStrictEqual([200]);
});

test('it holds a timer that a timer starts past the end of the run', () => {
  const clock = buildStubClock();
  const fire = mock((): void => {});

  clock.startTimer(() => {
    clock.startTimer(fire, 15);
  }, 10);

  clock.runFor(20);

  expect(fire).not.toHaveBeenCalled();
  expect(clock.countPending()).toBe(1);
});

test('it counts the timers that have neither fired nor been cancelled', () => {
  const clock = buildStubClock();

  clock.startTimer(() => {}, 10);
  clock.startTimer(() => {}, 30);
  clock.runFor(10);

  expect(clock.countPending()).toBe(1);
});
