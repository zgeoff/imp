export interface KeyedMutex {
  // runs `task` after every task queued earlier for the same key
  readonly runExclusive: <T>(key: string, task: () => Promise<T>) => Promise<T>;

  // true while a task for `key` runs or waits
  readonly isLocked: (key: string) => boolean;
}

export function createKeyedMutex(): KeyedMutex {
  // per key, a promise that resolves when the newest queued task is done;
  // it never rejects, so a failed task never blocks the next one
  const tails = new Map<string, Promise<void>>();

  return {
    runExclusive: async <T>(key: string, task: () => Promise<T>): Promise<T> => {
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
    },
    isLocked: (key) => tails.has(key),
  };
}
