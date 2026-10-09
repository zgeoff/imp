import type { TryResult } from '../imps/keyed-mutex';
import { waitWithin } from '../process/wait-within';

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

export function createStorageGate(): StorageGate {
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

      const deadline = Date.now() + timeoutMs;

      state.waiting += 1;

      try {
        // the check and the claim run in one synchronous step: no join slips in
        while (state.inFlight > 0) {
          const left = deadline - Date.now();

          if (left <= 0) {
            return { ran: false };
          }

          await waitWithin(state.idle.promise, left);
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
