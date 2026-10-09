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

    // moves the clock on by `ms`, running each timer as its due time comes:
    // the clock reads that time while it runs, so a timer it schedules that
    // falls due within `ms` runs in this advance too, as real timers would
    advance: (ms: number) => {
      const endMs = state.nowMs + ms;

      const findNext = () =>
        [...timers.entries()]
          .filter(([, timer]) => timer.dueMs <= endMs)
          .toSorted(([, a], [, b]) => a.dueMs - b.dueMs)
          .at(0);

      for (let next = findNext(); next !== undefined; next = findNext()) {
        const [id, timer] = next;

        timers.delete(id);

        state.nowMs = Math.max(state.nowMs, timer.dueMs);

        timer.run();
      }

      state.nowMs = endMs;
    },
  };
}
