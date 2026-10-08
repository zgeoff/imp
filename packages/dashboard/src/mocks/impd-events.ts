import type { Imp, ImpEvent } from '@imp/api';
import { EVENT_VERSION } from '@imp/api';

type ImpdEventListener = (event: ImpEvent) => void;

// The event streams the dashboard holds open now, one listener each; the
// preload clears it after each test
export const impdEventListeners = new Set<ImpdEventListener>();

// sends an event to every open stream, as impd does after a change
export function emitImpdEvent(event: ImpEvent): void {
  for (const listener of impdEventListeners) {
    listener(event);
  }
}

// The stream events.stream answers with: every imp as a snapshot, then each
// event emitted while it is open, until the caller lets go
export async function* openImpdEventStream(
  imps: readonly Imp[],
  signal: AbortSignal | undefined,
): AsyncGenerator<ImpEvent> {
  const queue: ImpEvent[] = imps.map((imp) => ({
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'ImpAdded',
    reason: 'snapshot',
    imp,
  }));

  const state = { wake: (): void => {} };

  const handleEvent = (event: ImpEvent): void => {
    queue.push(event);
    state.wake();
  };

  const stopStream = (): void => {
    state.wake();
  };

  impdEventListeners.add(handleEvent);
  signal?.addEventListener('abort', stopStream);

  try {
    for (;;) {
      if (signal?.aborted === true) {
        return;
      }

      const next = queue.shift();

      if (next === undefined) {
        const waiting = Promise.withResolvers<undefined>();

        state.wake = () => {
          waiting.resolve(undefined);
        };

        await waiting.promise;
      } else {
        yield next;
      }
    }
  } finally {
    impdEventListeners.delete(handleEvent);
    signal?.removeEventListener('abort', stopStream);
  }
}
