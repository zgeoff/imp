import type { ImpEvent } from '@imp/api';

// Every lifecycle event, to whoever listens: the event stream's subscribers,
// the proxy and broker resync, and the metrics. The database publishes its
// imp writes on a bus of its own type (db/imp-write-feed.ts).
export interface EventBus<T = Readonly<ImpEvent>> {
  readonly publish: (event: T) => void;

  // returns the unsubscribe
  readonly subscribe: (listener: (event: T) => void) => () => void;
}

export function createEventBus<T = Readonly<ImpEvent>>(): EventBus<T> {
  const listeners = new Set<(event: T) => void>();

  return {
    publish: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
