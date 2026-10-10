import type { TickerTimer } from '../process/ticker';

interface PendingRun {
  readonly run: () => Promise<void>;
  readonly ms: number;
}

// The timers a ticker waits on, stepped by hand: a scheduled run starts only
// when the test fires its label, never on its own. It holds one pending run
// per label, as a ticker schedules its next tick only after the last ends.
export function buildStubTickerTimer() {
  const pending = new Map<string, PendingRun>();

  const holdRun: TickerTimer = (label, run, ms) => {
    const entry: PendingRun = { run, ms };

    pending.set(label, entry);

    return () => {
      if (pending.get(label) === entry) {
        pending.delete(label);
      }
    };
  };

  return {
    timer: holdRun,

    // runs the pending run of `label`, as if its delay had passed, and
    // waits for the tick it starts
    fire: async (label: string): Promise<void> => {
      const entry = pending.get(label);

      if (entry === undefined) {
        throw new Error(`nothing waits on a timer named ${label}`);
      }

      pending.delete(label);

      await entry.run();
    },

    // the delay of each pending run, by label
    readDelays: (): Record<string, number> =>
      Object.fromEntries([...pending].map(([label, entry]) => [label, entry.ms])),
  };
}
