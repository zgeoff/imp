import type { After } from '../after';

export interface StubAfter {
  // pass as the code's `after`
  readonly after: After;

  // fires every pending timer of `ms`, as if that much time had passed; each
  // fires once
  readonly fire: (ms: number) => void;

  // how many timers of `ms` wait now: a test waits for its code to start one
  readonly countPending: (ms: number) => number;
}

// A one-shot timer the test fires by hand, in place of setTimeout: nothing
// fires until the test calls `fire`, and a cancelled timer never fires.
export function buildStubAfter(): StubAfter {
  const pending = new Set<{ readonly ms: number; readonly fire: () => void }>();

  const listPending = (ms: number) => [...pending].filter((entry) => entry.ms === ms);

  return {
    after: (ms, fire) => {
      const entry = { ms, fire };

      pending.add(entry);

      return () => {
        pending.delete(entry);
      };
    },
    fire: (ms) => {
      for (const entry of listPending(ms)) {
        pending.delete(entry);
        entry.fire();
      }
    },
    countPending: (ms) => listPending(ms).length,
  };
}
