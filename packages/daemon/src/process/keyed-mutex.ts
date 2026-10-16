export type TryResult<T> = { readonly ran: true; readonly value: T } | { readonly ran: false };

export interface KeyedMutex {
  // runs `task` after every task queued earlier for the same key
  readonly runExclusive: <T>(key: string, task: () => Promise<T>) => Promise<T>;

  // runs `task` only when nothing holds or waits for `key`; never waits
  readonly tryRunExclusive: <T>(key: string, task: () => Promise<T>) => Promise<TryResult<T>>;

  // true while a task for `key` runs or waits
  readonly isLocked: (key: string) => boolean;

  // the tasks for `key` that run or wait: 2 once a second one queues behind
  // the first
  readonly countQueued: (key: string) => number;

  // resolves once no task runs or waits for any key
  readonly waitForAll: () => Promise<void>;
}

export function createKeyedMutex(): KeyedMutex {
  // per key, a promise that resolves when the newest queued task is done,
  // and how many tasks run or wait; the promise never rejects, so a failed
  // task never blocks the next one
  const queues = new Map<string, { tail: Promise<void>; count: number }>();

  const runExclusive = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const queue = queues.get(key) ?? { tail: Promise.resolve(), count: 0 };
    const previous = queue.tail;
    const done = Promise.withResolvers<void>();

    queue.tail = done.promise;
    queue.count += 1;

    queues.set(key, queue);

    try {
      await previous;

      return await task();
    } finally {
      done.resolve();

      queue.count -= 1;

      if (queue.count === 0) {
        queues.delete(key);
      }
    }
  };

  return {
    runExclusive,

    // the check and runExclusive's queues.set run in one synchronous step, so
    // no other task can slip in between
    tryRunExclusive: async (key, task) => {
      if (queues.has(key)) {
        return { ran: false };
      }

      const value = await runExclusive(key, task);

      return { ran: true, value };
    },
    isLocked: (key) => queues.has(key),
    countQueued: (key) => queues.get(key)?.count ?? 0,
    waitForAll: async () => {
      while (queues.size > 0) {
        await Promise.all([...queues.values()].map((queue) => queue.tail));
      }
    },
  };
}
