import type { ImpEvent } from '@imp/api';

type EventListener = (event: Readonly<ImpEvent>) => void;

// Every lifecycle event, to whoever listens: the event stream's subscribers,
// the proxy and broker resync, and the metrics.
export interface EventBus {
  readonly publish: (event: Readonly<ImpEvent>) => void;

  // returns the unsubscribe
  readonly subscribe: (listener: EventListener) => () => void;
}

export function createEventBus(): EventBus {
  const listeners = new Set<EventListener>();

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
