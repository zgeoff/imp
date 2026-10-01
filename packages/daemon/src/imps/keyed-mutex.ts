export type TryResult<T> = { readonly ran: true; readonly value: T } | { readonly ran: false };

export interface KeyedMutex {
  // runs `task` after every task queued earlier for the same key
  readonly runExclusive: <T>(key: string, task: () => Promise<T>) => Promise<T>;

  // runs `task` only when nothing holds or waits for `key`; never waits
  readonly tryRunExclusive: <T>(key: string, task: () => Promise<T>) => Promise<TryResult<T>>;

  // true while a task for `key` runs or waits
  readonly isLocked: (key: string) => boolean;
}

export function createKeyedMutex(): KeyedMutex {
  // per key, a promise that resolves when the newest queued task is done;
  // it never rejects, so a failed task never blocks the next one
  const tails = new Map<string, Promise<void>>();

  const runExclusive = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key);
    const done = Promise.withResolvers<void>();

    tails.set(key, done.promise);

    try {
      await previous;

      return await task();
    } finally {
      done.resolve();

      if (tails.get(key) === done.promise) {
        tails.delete(key);
      }
    }
  };

  return {
    runExclusive,

    // the check and runExclusive's tails.set run in one synchronous step, so
    // no other task can slip in between
    tryRunExclusive: async (key, task) => {
      if (tails.has(key)) {
        return { ran: false };
      }

      const value = await runExclusive(key, task);

      return { ran: true, value };
    },
    isLocked: (key) => tails.has(key),
  };
}
