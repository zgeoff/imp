import type { Repeat } from '../repeat';

export interface StubRepeat {
  // pass as the code's `repeat`
  readonly repeat: Repeat;

  // runs once every running repeat of `ms`, as if that much time had passed
  readonly tick: (ms: number) => void;

  // how many repeats of `ms` run now: a test waits for its code to start one
  readonly countRunning: (ms: number) => number;
}

// A timer the test steps by hand, in place of setInterval: nothing ticks
// until the test calls `tick`, and a stopped repeat never ticks again.
export function buildStubRepeat(): StubRepeat {
  const running = new Set<{ readonly ms: number; readonly tick: () => void }>();

  const listRunning = (ms: number) => [...running].filter((entry) => entry.ms === ms);

  return {
    repeat: (ms, tick) => {
      const entry = { ms, tick };

      running.add(entry);

      return () => {
        running.delete(entry);
      };
    },
    tick: (ms) => {
      for (const entry of listRunning(ms)) {
        entry.tick();
      }
    },
    countRunning: (ms) => listRunning(ms).length,
  };
}
