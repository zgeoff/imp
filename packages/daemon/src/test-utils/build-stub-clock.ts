// A clock with timers that moves only with runFor: each timer whose time the
// clock passes fires in time order, with the clock at that time, as
// setTimeout's would. `delays` records each timer's delay as it started.
export function buildStubClock() {
  const state = { nowMs: 0, nextId: 0 };

  const pending = new Map<number, { at: number; fire: () => void }>();

  const delays: number[] = [];

  return {
    delays,
    now: (): number => state.nowMs,

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
    runFor: (ms: number): void => {
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
    },
  };
}
