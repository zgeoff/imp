import type { ImpEvent } from '@impz/api';
import { ORPCError } from '@orpc/client';
import pRetry, { AbortError } from 'p-retry';
import type { RetryContext } from 'p-retry';
import type { CallOptions } from '../types';
import { UnknownProcedureError } from '../unknown-procedure-error';

// the stream call of a client: any client of impd passes
export interface EventSource {
  readonly events: {
    readonly stream: (input?: undefined, options?: CallOptions) => Promise<AsyncIterable<ImpEvent>>;
  };
}

export interface WatchEventsOptions {
  // each event in order; the next waits until this settles, and a throw
  // ends the watch with it
  readonly onEvent: (event: ImpEvent) => Promise<void> | void;

  // only the events of this imp
  readonly name?: string;
  readonly signal?: AbortSignal;

  // each stream once it opened, numbered from 1; every stream starts with a
  // snapshot of every imp, and a throw ends the watch with it
  readonly onOpen?: (attempt: number) => Promise<void> | void;

  // opens a fresh stream after one ends, as when impd restarts or drops a
  // reader that fell behind; without it the watch ends with its stream
  readonly reconnect?: WatchReconnect;
}

export interface WatchReconnect {
  // the wait before each new stream
  readonly delayMs: number;

  // whether a failed stream opens again; by default all but impd's refusal
  // of the call (a 4xx answer, or no such procedure on an older impd)
  readonly shouldRetry?: (error: unknown) => boolean;
}

// One consumer of impd's event stream. Resolves once the signal aborts, or
// once the stream ends with no reconnect; rejects with the stream's failure
// or a callback's throw.
export async function watchEvents(
  client: EventSource,
  options: Readonly<WatchEventsOptions>,
): Promise<void> {
  const signal = options.signal;
  const reconnect = options.reconnect;
  const callOptions: CallOptions = signal === undefined ? {} : { signal };

  const readStream = async (attempt: number): Promise<void> => {
    const stream = await client.events.stream(undefined, callOptions).catch((error: unknown) => {
      throw new StreamEndError(error);
    });

    await runCallback(() => options.onOpen?.(attempt));

    const events = stream[Symbol.asyncIterator]();
    const reading = { done: false };

    try {
      for (;;) {
        const next = await events.next().catch((error: unknown) => {
          throw new StreamEndError(error);
        });

        if (next.done === true) {
          reading.done = true;
          throw new StreamEndError(null);
        }

        if (options.name === undefined || readEventImpName(next.value) === options.name) {
          await runCallback(() => options.onEvent(next.value));
        }
      }
    } finally {
      // a callback that threw leaves the stream open; close it
      if (!reading.done) {
        void events.return?.();
      }
    }
  };

  const shouldReconnect = (context: RetryContext): boolean => {
    const error = context.error;
    const shouldRetry = reconnect?.shouldRetry ?? isNotRefused;

    return error instanceof StreamEndError && (error.reason === null || shouldRetry(error.reason));
  };

  try {
    await (reconnect === undefined
      ? readStream(1)
      : pRetry(readStream, {
          retries: Number.POSITIVE_INFINITY,
          minTimeout: reconnect.delayMs,
          factor: 1,
          ...(signal !== undefined && { signal }),
          shouldRetry: shouldReconnect,
        }));
  } catch (error) {
    requireCleanEnd(error, signal);
  }
}

// how one stream ended: its failure, or null when impd closed it
class StreamEndError extends Error {
  override name = 'StreamEndError';

  readonly reason: unknown;

  constructor(reason: unknown) {
    const message = reason instanceof Error ? reason.message : 'the event stream ended';

    super(message);

    this.reason = reason;
  }
}

// a callback's throw ends the watch at once, with that throw
async function runCallback(run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));

    throw new AbortError(failure);
  }
}

// the imp an event is about
function readEventImpName(event: Readonly<ImpEvent>): string {
  switch (event.ev) {
    case 'ImpAdded':
    case 'ImpChanged':
    case 'ImpRemoved': {
      return event.imp.name;
    }
    case 'CheckpointAdded':
    case 'CheckpointRemoved':
    case 'GovernorDecision':
    case 'AgentExec': {
      return event.name;
    }
    default: {
      return event satisfies never;
    }
  }
}

// impd refusing the call refuses it again; a 5xx, a dropped connection or a
// restart may answer next time
function isNotRefused(error: unknown): boolean {
  if (error instanceof UnknownProcedureError) {
    return false;
  }

  return !(error instanceof ORPCError && error.status >= 400 && error.status < 500);
}

// the end of a watch as its caller sees it: nothing once the signal aborted
// or impd closed the stream, else the failure as it came
function requireCleanEnd(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    return;
  }

  // without a reconnect nothing unwraps a callback's throw
  if (error instanceof AbortError) {
    throw error.originalError;
  }

  if (!(error instanceof StreamEndError)) {
    throw error;
  }

  if (error.reason !== null) {
    throw error.reason;
  }
}
