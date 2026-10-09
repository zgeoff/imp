// A clock from `startMs` (0) that moves only with runFor: each timer it passes
// fires in time order, with the clock at that time, as setTimeout's would.
// `delays` and `sleeps` record each timer and each sleep.
export function buildStubClock(options: Readonly<{ startMs?: number }> = {}) {
  const state = { nowMs: options.startMs ?? 0, nextId: 0 };

  const pending = new Map<number, { at: number; fire: () => void }>();

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

      state.nowMs = timer.at;

      timer.fire();
    }

    state.nowMs = until;
  };

  return {
    delays,
    sleeps,
    now: (): number => state.nowMs,
    runFor,

    // an injected sleep: it moves the clock by `ms`, and records it
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);

      runFor(ms);

      return Promise.resolve();
    },

    // starts a timer `ms` from now; returns its cancel
    startTimer: (fire: () => void, ms: number): (() => void) => {
      state.nextId += 1;

      const id = state.nextId;

      delays.push(ms);
      pending.set(id, { at: state.nowMs + ms, fire });

      return () => {
        pending.delete(id);
      };
    },
  };
}
