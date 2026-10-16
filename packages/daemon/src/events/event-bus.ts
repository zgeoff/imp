import type { ImpEvent } from '@impz/api';
import { printLog } from '../process/print-log';
import { readErrorMessage } from '../read-error-message';

// Every lifecycle event, to whoever listens: the event stream's subscribers,
// the proxy and broker resync, and the metrics. The database publishes its
// imp writes on a bus of its own type (db/imp-write-feed.ts).
export interface EventBus<T = Readonly<ImpEvent>> {
  readonly publish: (event: T) => void;

  // returns the unsubscribe
  readonly subscribe: (listener: (event: T) => void) => () => void;
}

// A listener that throws is logged and passed over: the rest still hear the
// event, and the publisher, such as a database write that has committed,
// never sees the throw.
export function createEventBus<T = Readonly<ImpEvent>>(
  log: (message: string) => void = printLog,
): EventBus<T> {
  const listeners = new Set<(event: T) => void>();

  return {
    publish: (event) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          log(`impd: events: a listener failed: ${readErrorMessage(error)}`);
        }
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
