import type { Clock } from '../process/clock';
import type { TryResult } from '../process/keyed-mutex';
import { REAL_CLOCK } from '../process/real-clock';

// An operation that may make storage before its rows commit runs in `join`.
// `runAlone` (the GC) waits until none is in flight, and holds new ones back
// only while it runs, never while it waits.
export interface StorageGate {
  readonly join: <T>(task: () => Promise<T>) => Promise<T>;

  // ran: false when operations kept the gate busy for `timeoutMs`
  readonly runAlone: <T>(task: () => Promise<T>, timeoutMs: number) => Promise<TryResult<T>>;
  readonly countInFlight: () => number;

  // the tasks that wait to run alone, for operations in flight to end
  readonly countWaiting: () => number;
}

// The wall clock and setTimeout by default; tests pass a clock they step
export function createStorageGate(
  clock: Pick<Clock, 'now' | 'startTimer'> = REAL_CLOCK,
): StorageGate {
  const state = {
    inFlight: 0,
    waiting: 0,

    // set while a task runs alone; joins wait for it
    alone: null as Promise<void> | null,
    idle: Promise.withResolvers<void>(),
  };

  const runJoined = async <T>(task: () => Promise<T>): Promise<T> => {
    while (state.alone !== null) {
      await state.alone;
    }

    state.inFlight += 1;

    try {
      return await task();
    } finally {
      state.inFlight -= 1;

      if (state.inFlight === 0) {
        state.idle.resolve();

        state.idle = Promise.withResolvers<void>();
      }
    }
  };

  // one alone at a time
  const queue = { tail: Promise.resolve() };

  const runAlone = async <T>(task: () => Promise<T>, timeoutMs: number): Promise<TryResult<T>> => {
    const previous = queue.tail;
    const done = Promise.withResolvers<void>();

    queue.tail = done.promise;

    try {
      await previous;

      const deadline = clock.now() + timeoutMs;

      state.waiting += 1;

      try {
        // the check and the claim run in one synchronous step: no join slips in
        while (state.inFlight > 0) {
          const left = deadline - clock.now();

          if (left <= 0) {
            return { ran: false };
          }

          const expired = Promise.withResolvers<void>();

          const cancel = clock.startTimer(() => {
            expired.resolve();
          }, left);

          try {
            await Promise.race([state.idle.promise, expired.promise]);
          } finally {
            cancel();
          }
        }
      } finally {
        state.waiting -= 1;
      }

      state.alone = done.promise;

      return { ran: true, value: await task() };
    } finally {
      state.alone = null;

      done.resolve();
    }
  };

  return {
    join: runJoined,
    runAlone,
    countInFlight: () => state.inFlight,
    countWaiting: () => state.waiting,
  };
}
