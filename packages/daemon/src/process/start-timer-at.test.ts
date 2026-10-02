import { expect, test } from 'bun:test';
import { startTimerAt } from './start-timer-at';

const DAY_MS = 86_400_000;

// a clock the test moves with runFor; a timer runs when the clock passes its
// time
function createFakeClock() {
  const state = { now: 0, nextId: 0 };

  const pending = new Map<number, { at: number; fire: () => void }>();

  const delays: number[] = [];

  const startTimer = (fire: () => void, ms: number) => {
    state.nextId += 1;

    const id = state.nextId;

    delays.push(ms);
    pending.set(id, { at: state.now + ms, fire });

    return () => {
      pending.delete(id);
    };
  };

  const runFor = (ms: number): void => {
    const until = state.now + ms;

    for (;;) {
      const [due] = [...pending]
        .filter(([, timer]) => timer.at <= until)
        .toSorted(([, a], [, b]) => a.at - b.at);

      if (due === undefined) {
        break;
      }

      const [id, timer] = due;

      pending.delete(id);

      state.now = timer.at;

      timer.fire();
    }

    state.now = until;
  };

  return { startTimer, runFor, delays, now: () => state.now };
}

test('a time 30 days off waits in steps setTimeout can take, then fires once at it', () => {
  const clock = createFakeClock();
  const fired: number[] = [];

  startTimerAt(
    () => {
      fired.push(clock.now());
    },
    30 * DAY_MS,
    { now: clock.now, startTimer: clock.startTimer },
  );

  clock.runFor(30 * DAY_MS - 1);

  expect(fired).toEqual([]);

  clock.runFor(1);

  expect(fired).toEqual([30 * DAY_MS]);
  expect(Math.max(...clock.delays)).toBeLessThanOrEqual(2 ** 31 - 1);
});

test('a cancel stops it, even between steps', () => {
  const clock = createFakeClock();
  let fired = false;

  const cancel = startTimerAt(
    () => {
      fired = true;
    },
    30 * DAY_MS,
    { now: clock.now, startTimer: clock.startTimer },
  );

  clock.runFor(26 * DAY_MS);

  cancel();

  clock.runFor(10 * DAY_MS);

  expect(fired).toBeFalse();
});

test('a time that is not finite fires at once', () => {
  const clock = createFakeClock();
  const fired: string[] = [];

  for (const at of [Number.NaN, Number.POSITIVE_INFINITY]) {
    startTimerAt(
      () => {
        fired.push(String(at));
      },
      at,
      { now: clock.now, startTimer: clock.startTimer },
    );
  }

  clock.runFor(0);

  expect(fired).toEqual(['NaN', 'Infinity']);
});
