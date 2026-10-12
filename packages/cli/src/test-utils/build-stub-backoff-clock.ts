// A reconnect backoff's clock: `wait` ends at once, moves `now` on by its
// delay and records it in `delays`, and runs `onWait` during the wait numbered
// `at` (1 is the first), as a server that comes back while the client waits.
export function buildStubBackoffClock(options: Readonly<{ at: number; onWait: () => void }>) {
  const state = { nowMs: 0 };
  const delays: number[] = [];

  const wait = (ms: number): Promise<void> => {
    delays.push(ms);

    state.nowMs += ms;

    if (delays.length === options.at) {
      options.onWait();
    }

    return Promise.resolve();
  };

  return {
    wait,
    delays,
    now: (): number => state.nowMs,

    // time that passes outside a wait, such as a stream that stays open
    advance: (ms: number): void => {
      state.nowMs += ms;
    },
  };
}
