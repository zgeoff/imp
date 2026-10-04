import type { SessionLog } from '@imp/api';
import type { ImpClient } from '../create-imp-client';
import { formatOutput, formatSessionLogs } from '../format-output';
import { requireFeature } from '../require-feature';
import { UsageError } from '../usage-error';

// `imp sessions logs|log|log-rm`: the session logs impd keeps on the host
// (docs/guides/session-logs.md). None of them wakes the imp.

// what the verbs call
type SessionLogClient = Pick<ImpClient, 'sessions' | 'system'>;

const LOGS_USAGE = 'usage: imp sessions logs <name> [session]';
const LOG_USAGE = 'usage: imp sessions log <name> <session> [generation] [--from <offset>]';
const LOG_RM_USAGE = 'usage: imp sessions log-rm <name> [session] [generation]';

export async function listSessionLogs(
  client: SessionLogClient,
  positionals: readonly string[],
  isJson: boolean,
): Promise<void> {
  const [name, session] = positionals;

  if (name === undefined || positionals.length > 2) {
    throw new UsageError(LOGS_USAGE);
  }

  await requireFeature(client, 'sessionLog', 'list no logs');

  const logs = await client.sessions.logs({ name, ...(session !== undefined && { session }) });

  console.log(formatOutput(logs, isJson, formatSessionLogs));
}

// the newest log of the session when no generation is named
async function findGeneration(
  client: SessionLogClient,
  name: string,
  session: string,
  generation: string | undefined,
): Promise<string> {
  if (generation !== undefined) {
    return generation;
  }

  const logs: readonly SessionLog[] = await client.sessions.logs({ name, session });

  const [newest] = logs;

  if (newest === undefined) {
    throw new Error(`imp ${name} has no log of session ${session}`);
  }

  return newest.executionGeneration;
}

function parseOffset(value: unknown): number {
  if (value === undefined) {
    return 0;
  }

  if (typeof value !== 'string') {
    throw new UsageError('--from needs an offset');
  }

  const offset = Number(value);

  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new UsageError(`--from must be an offset, a whole number of bytes, not ${value}`);
  }

  return offset;
}

// Writes the raw output from `--from` to the log's end on stdout; a range
// the log lost goes to stderr, as the ring's gap would.
export async function writeSessionLog(
  client: SessionLogClient,
  positionals: readonly string[],
  from: unknown,
): Promise<void> {
  const [name, session, named] = positionals;

  if (name === undefined || session === undefined || positionals.length > 3) {
    throw new UsageError(LOG_USAGE);
  }

  let offset = parseOffset(from);

  await requireFeature(client, 'sessionLog', 'read no log');

  const executionGeneration = await findGeneration(client, name, session, named);

  // the output of one generation only: a reader who named none learns which
  if (named === undefined) {
    console.error(`imp: generation ${executionGeneration}`);
  }

  for (;;) {
    const read = await client.sessions.readLog({
      name,
      session,
      executionGeneration,
      from: offset,
    });

    if (read.gap !== undefined) {
      console.error(
        `imp: bytes ${String(read.gap.from)} to ${String(read.gap.to)} are not in the log`,
      );
    }

    const buffer = await read.data.arrayBuffer();

    const data = new Uint8Array(buffer);

    if (data.byteLength === 0) {
      return;
    }

    process.stdout.write(data);

    offset = read.offset + data.byteLength;
  }
}

export async function removeSessionLogs(
  client: SessionLogClient,
  positionals: readonly string[],
): Promise<void> {
  const [name, session, executionGeneration] = positionals;

  if (name === undefined || positionals.length > 3) {
    throw new UsageError(LOG_RM_USAGE);
  }

  await requireFeature(client, 'sessionLog', 'delete no log');

  const result = await client.sessions.deleteLog({
    name,
    ...(session !== undefined && { session }),
    ...(executionGeneration !== undefined && { executionGeneration }),
  });

  console.log(`deleted ${String(result.deleted)} session logs of ${name}`);
}
