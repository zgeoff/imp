import type { ImpEvent } from '@imp/api';
import type { ServerCheck } from '@zgeoff/imp-client';
import type { EventSource } from '../commands/events';

// one connection to impd's event stream, as the stub plays it
interface StubStream {
  // what the stream sends before impd ends it
  readonly events?: readonly ImpEvent[];

  // the open fails with this instead, as a dropped network or a refusal
  readonly failure?: Error;

  // how long the stream lasts, on the stub's clock
  readonly lastsMs?: number;
}

interface StubEventSourceOptions {
  // the connections in turn; once they run out, each stream ends at once
  readonly streams: readonly StubStream[];

  // what impd's version check answers
  readonly check: ServerCheck;
}

async function* listEvents(events: readonly ImpEvent[]): AsyncGenerator<ImpEvent> {
  for (const event of events) {
    yield await Promise.resolve(event);
  }
}

// The event stream `imp events` reads, on a clock that moves only as each
// stream lasts: `backoffs` holds every wait, `warnings` every reconnect line.
export function buildStubEventSource(options: Readonly<StubEventSourceOptions>) {
  const streams = [...options.streams];
  const clock = { nowMs: 0 };
  const backoffs: number[] = [];
  const warnings: string[] = [];

  const source: EventSource = {
    openStream: () => {
      const next = streams.shift() ?? {};

      clock.nowMs += next.lastsMs ?? 0;

      if (next.failure !== undefined) {
        return Promise.reject(next.failure);
      }

      return Promise.resolve(listEvents(next.events ?? []));
    },
    checkServer: () => Promise.resolve(options.check),
    now: () => clock.nowMs,
    wait: (ms) => {
      backoffs.push(ms);

      return Promise.resolve();
    },
    warn: (line) => {
      warnings.push(line);
    },
  };

  return { source, backoffs, warnings };
}
