// one timer a unit started, for a test to read and fire
interface StubTimer {
  readonly ms: number;
  readonly fire: () => void;
  state: 'pending' | 'fired' | 'cancelled';
}

// setTimeout for a unit that takes a `startTimer(fire, ms)` returning its
// cancel: a timer fires only when the test fires it, never on the clock.
export function buildStubTimers() {
  const timers: StubTimer[] = [];
  const readPending = (): StubTimer[] => timers.filter((timer) => timer.state === 'pending');

  return {
    startTimer: (fire: () => void, ms: number): (() => void) => {
      const timer: StubTimer = { ms, fire, state: 'pending' };

      timers.push(timer);

      return () => {
        if (timer.state === 'pending') {
          timer.state = 'cancelled';
        }
      };
    },

    // the delay of each timer that has neither fired nor been cancelled
    readPendingMs: (): number[] => readPending().map((timer) => timer.ms),

    // fires each timer pending now, in the order they started; one a fire
    // starts waits for the next call
    firePending: (): void => {
      for (const timer of readPending()) {
        timer.state = 'fired';

        timer.fire();
      }
    },
  };
}
