// One run per key at a time: a call while a run for its key is in flight
// joins that run and settles with it, and the key is free again once it
// settles, whether it resolved or rejected.
export interface SingleFlight<T> {
  readonly run: (key: string, task: () => Promise<T>) => Promise<T>;

  // the run in flight for `key`, if any
  readonly findRun: (key: string) => Promise<T> | undefined;

  // the keys with a run in flight
  readonly listKeys: () => string[];

  // resolves once every run in flight now has settled, however it settled
  readonly waitForAll: () => Promise<void>;
}

export function createSingleFlight<T>(): SingleFlight<T> {
  const inflight = new Map<string, Promise<T>>();

  return {
    run: (key, task) => {
      const running = inflight.get(key);

      if (running !== undefined) {
        return running;
      }

      // set before the task starts, so a task that throws at once still
      // frees its key
      const settled = Promise.withResolvers<T>();

      inflight.set(key, settled.promise);

      void (async () => {
        try {
          const value = await task();

          settled.resolve(value);
        } catch (error) {
          settled.reject(error);
        } finally {
          inflight.delete(key);
        }
      })();

      return settled.promise;
    },
    findRun: (key) => inflight.get(key),
    listKeys: () => [...inflight.keys()],
    waitForAll: async () => {
      await Promise.allSettled(inflight.values());
    },
  };
}
