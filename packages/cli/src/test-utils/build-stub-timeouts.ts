import type { StartTimer } from '../hosts/fan-out';

// one timer a unit started, as the test reads it
interface StubTimeout {
  readonly ms: number;
  state: 'pending' | 'fired' | 'cancelled';
}

// setTimeout for a unit that takes fan-out's `startTimer(ms, fire)`, which
// returns its cancel: a timer fires only when the test fires it, never on
// the clock. `timers` holds each one in the order it started.
export function buildStubTimeouts() {
  const timers: StubTimeout[] = [];

  const fires = new Map<StubTimeout, () => void>();

  const startTimer: StartTimer = (ms, fire) => {
    const timer: StubTimeout = { ms, state: 'pending' };

    timers.push(timer);
    fires.set(timer, fire);

    return () => {
      if (timer.state === 'pending') {
        timer.state = 'cancelled';
      }
    };
  };

  return {
    startTimer,
    timers,

    // fires each timer pending now, in the order they started
    firePending: (): void => {
      for (const timer of timers.filter((pending) => pending.state === 'pending')) {
        timer.state = 'fired';
        fires.get(timer)?.();
      }
    },
  };
}
