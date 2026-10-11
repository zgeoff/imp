import type { Repeat } from '../images/build-event-stream';

export interface StubRepeat {
  // pass as the code's `repeat`
  readonly repeat: Repeat;

  // runs once every running repeat of `ms`, as if that much time had passed
  readonly tick: (ms: number) => void;

  // how many repeats of `ms` run now: a test waits for its code to start one
  readonly countRunning: (ms: number) => number;

  // the tick of each repeat of `ms` started so far, stopped ones too: a test
  // calls one late, as an interval that fell due as it was stopped
  readonly listStartedTicks: (ms: number) => (() => void)[];
}

// A timer the test steps by hand, in place of setInterval: nothing ticks
// until the test calls `tick`, and a stopped repeat never ticks again.
export function buildStubRepeat(): StubRepeat {
  const running = new Set<{ readonly ms: number; readonly tick: () => void }>();

  const started: { readonly ms: number; readonly tick: () => void }[] = [];
  const listRunning = (ms: number) => [...running].filter((entry) => entry.ms === ms);

  return {
    repeat: (ms, tick) => {
      const entry = { ms, tick };

      running.add(entry);
      started.push(entry);

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
    listStartedTicks: (ms) => started.filter((entry) => entry.ms === ms).map((entry) => entry.tick),
  };
}
