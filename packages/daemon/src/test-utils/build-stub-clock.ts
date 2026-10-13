import type { Clock } from '../process/clock';

interface StubTimer {
  readonly at: number;
  readonly ms: number;
  readonly fire: () => void;
}

// The one fake Clock for tests, from `startMs` (0): runFor moves the time and
// fires the timers it passes in time order, as setTimeout's would;
// firePending fires them by hand and leaves the time where it is.
export function buildStubClock(options: Readonly<{ startMs?: number }> = {}) {
  const state = { nowMs: options.startMs ?? 0, nextId: 0 };

  // by id, so in the order they started
  const pending = new Map<number, StubTimer>();

  const delays: number[] = [];
  const sleeps: number[] = [];

  const runFor = (ms: number): void => {
    const until = state.nowMs + ms;

    for (;;) {
      const [due] = [...pending]
        .filter(([, timer]) => timer.at <= until)
        .toSorted(([, a], [, b]) => a.at - b.at);

      if (due === undefined) {
        break;
      }

      const [id, timer] = due;

      pending.delete(id);

      state.nowMs = Math.max(state.nowMs, timer.at);

      timer.fire();
    }

    state.nowMs = until;
  };

  // starts a timer `ms` from now; returns its cancel
  const startTimer = (fire: () => void, ms: number): (() => void) => {
    state.nextId += 1;

    const id = state.nextId;

    delays.push(ms);
    pending.set(id, { at: state.nowMs + ms, ms, fire });

    return () => {
      pending.delete(id);
    };
  };

  // an injected sleep: it moves the clock by `ms`, and records it
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);

    runFor(ms);

    return Promise.resolve();
  };

  const clock: Clock = { now: () => state.nowMs, startTimer, sleep };

  return {
    ...clock,
    delays,
    sleeps,
    runFor,

    // fires each timer pending now once, in the order they started; one a
    // fire starts waits for the next call
    firePending: (): void => {
      const pendingNow = [...pending];

      for (const [id, timer] of pendingNow) {
        // a fire before it may have cancelled it
        if (pending.delete(id)) {
          timer.fire();
        }
      }
    },

    // the delay of each timer that has neither fired nor been cancelled
    readPendingMs: (): number[] => [...pending.values()].map((timer) => timer.ms),

    countPending: (): number => pending.size,
  };
}
