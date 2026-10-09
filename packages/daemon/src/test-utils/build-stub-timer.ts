// A clock and timers that move only when the test advances them, in place of
// Date.now and setTimeout (move-parts.ts's PartTimer). A due timer runs once,
// in the order of its due time; a cancelled one never runs.
export function buildStubTimer(startMs = 0) {
  const state = { nowMs: startMs, nextId: 0 };

  const timers = new Map<number, { readonly dueMs: number; readonly run: () => void }>();

  return {
    now: () => state.nowMs,
    schedule: (run: () => void, ms: number) => {
      const id = state.nextId;

      state.nextId += 1;

      timers.set(id, { dueMs: state.nowMs + ms, run });

      return () => {
        timers.delete(id);
      };
    },

    // the timers scheduled and not yet run or cancelled
    countPending: () => timers.size,

    // moves the clock on by `ms`, then runs each timer now due
    advance: (ms: number) => {
      state.nowMs += ms;

      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueMs <= state.nowMs)
        .toSorted(([, a], [, b]) => a.dueMs - b.dueMs);

      for (const [id, timer] of due) {
        timers.delete(id);
        timer.run();
      }
    },
  };
}
