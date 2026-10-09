import type { ImpEvent } from '@imp/api';
import { startTimerAt } from '../process/start-timer-at';
import type { EventBus } from './event-bus';

// events one subscriber may fall behind by before its stream ends
const QUEUE_LIMIT = 1000;

interface EventStreamOptions {
  readonly bus: EventBus;

  // every imp as `ImpAdded`, read from the database
  readonly readSnapshot: () => Promise<readonly ImpEvent[]>;
  readonly signal?: AbortSignal | undefined;

  // when the stream must end, such as a dashboard session's expiry; null for
  // never
  readonly endsAt: number | null;
  readonly now: () => number;

  // starts the end's timer and returns its cancel; setTimeout by default
  readonly startTimer?: (fire: () => void, ms: number) => () => void;
  readonly queueLimit?: number;

  // the events this subscriber may see, such as those of a token's imps;
  // the snapshot is filtered by its reader
  readonly accepts?: (event: ImpEvent) => boolean;
}

// The snapshot, then every event behind it (docs/guides/events.md). It
// subscribes before the snapshot read, so no event falls between the two.
export async function* openEventStream(options: EventStreamOptions): AsyncGenerator<ImpEvent> {
  const limit = options.queueLimit ?? QUEUE_LIMIT;
  const queue: ImpEvent[] = [];
  const state = { ended: false, wake: (): void => {} };

  const stopStream = (): void => {
    state.ended = true;

    state.wake();
  };

  const unsubscribe = options.bus.subscribe((event) => {
    if (options.accepts !== undefined && !options.accepts(event)) {
      return;
    }

    if (queue.length >= limit) {
      stopStream();

      return;
    }

    queue.push(event);
    state.wake();
  });

  options.signal?.addEventListener('abort', stopStream);

  // a dashboard session's stream ends with it, 30 days on
  const cancelTimer =
    options.endsAt === null
      ? null
      : startTimerAt(stopStream, options.endsAt, {
          now: options.now,
          ...(options.startTimer !== undefined && { startTimer: options.startTimer }),
        });

  try {
    const snapshot = await options.readSnapshot();

    yield* snapshot;

    for (;;) {
      const next = queue.shift();

      if (state.ended) {
        return;
      }

      if (next !== undefined) {
        yield next;
        continue;
      }

      const waiting = Promise.withResolvers<undefined>();

      state.wake = () => {
        waiting.resolve(undefined);
      };

      await waiting.promise;
    }
  } finally {
    unsubscribe();
    options.signal?.removeEventListener('abort', stopStream);
    cancelTimer?.();
  }
}
