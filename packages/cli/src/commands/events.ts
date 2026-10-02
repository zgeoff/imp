import type { ImpEvent } from '@imp/api';
import { ORPCError } from '@orpc/client';
import type { ServerCheck } from '@zgeoff/imp-client';
import { defineCommand } from '../define-command';
import { runAction } from '../run-action';

// ends in a row before imp events gives up
const MAX_FAILURES = 5;

// a stream that lasted this long was healthy; the count starts again
const HEALTHY_MS = 10_000;
const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15_000;

// what printEvents needs of the client and the clock, so a test can script
// the stream
export interface EventSource {
  readonly openStream: () => Promise<AsyncIterable<ImpEvent>>;
  readonly checkServer: () => Promise<ServerCheck>;
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;

  // one line on stderr for each reconnect
  readonly warn: (line: string) => void;
}

// A stream ends when impd drops a reader that fell behind, restarts, or the
// network drops. Each end reconnects after a backoff, to a fresh snapshot;
// MAX_FAILURES ends in a row, none of them healthy, is an error.
export async function printEvents(
  source: EventSource,
  name: string | null,
  print: (line: string) => void,
): Promise<void> {
  let failures = 0;

  for (;;) {
    const startedAt = source.now();

    const ended = await readStream(source, name, print);

    if (source.now() - startedAt >= HEALTHY_MS) {
      failures = 0;
    }

    failures += 1;

    if (failures >= MAX_FAILURES) {
      throw new Error(`the event stream ended ${String(failures)} times in a row: ${ended}`);
    }

    const backoffMs = Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);

    source.warn(`imp: the event stream ended (${ended}); reconnecting in ${String(backoffMs)}ms`);

    await source.wait(backoffMs);
  }
}

// Prints the stream until it ends, and says why it ended. An impd that
// refuses the call (no stream, no access) is an error, not an end.
async function readStream(
  source: EventSource,
  name: string | null,
  print: (line: string) => void,
): Promise<string> {
  try {
    const stream = await source.openStream();

    for await (const event of stream) {
      if (name === null || readImpName(event) === name) {
        print(JSON.stringify(event));
      }
    }

    return 'impd closed it';
  } catch (error) {
    if (!(error instanceof ORPCError) || error.status < 400 || error.status >= 500) {
      return error instanceof Error ? error.message : String(error);
    }

    // an impd from before the stream answers NOT_FOUND; say which to upgrade
    if (error.status === 404) {
      const check = await source.checkServer();

      throw new Error(
        `impd ${check.serverVersion} has no event stream; upgrade it to ${check.clientVersion}`,
        { cause: error },
      );
    }

    throw error;
  }
}

function readImpName(event: Readonly<ImpEvent>): string {
  if (event.ev === 'ImpAdded' || event.ev === 'ImpChanged' || event.ev === 'ImpRemoved') {
    return event.imp.name;
  }

  return event.name;
}

export const eventsCommand = defineCommand({
  meta: {
    name: 'events',
    description: 'Follow impd: every imp, then each change, as one JSON object a line',
  },
  args: {
    name: { type: 'positional', description: 'imp name (default: every imp)', required: false },
  },
  run: (context) =>
    runAction(context.host, (client) =>
      printEvents(
        {
          openStream: () => client.events.stream(),
          checkServer: () => client.checkServer(),
          now: Date.now,
          wait: (ms) => Bun.sleep(ms),
          warn: (line) => {
            console.error(line);
          },
        },
        context.args.name ?? null,
        (line) => {
          console.log(line);
        },
      ),
    ),
});
