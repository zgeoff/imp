import type { SessionLog } from '@impz/api';
import { requireFeatures } from '@impz/client';
import type { CommandIO } from '../command-io';
import type { ImpClient } from '../create-imp-client';
import { formatOutput, formatSessionLogs } from '../format-output';
import { UsageError } from '../usage-error';

// `impz sessions logs|log|log-rm`: the session logs impd keeps on the host
// (docs/guides/session-logs.md). None of them wakes the imp.

// what the verbs call
type SessionLogClient = Pick<ImpClient, 'sessions' | 'system'>;

const LOGS_USAGE = 'usage: impz sessions logs <name> [session]';
const LOG_USAGE = 'usage: impz sessions log <name> <session> [generation] [--from <offset>]';
const LOG_RM_USAGE = 'usage: impz sessions log-rm <name> [session] [generation]';

export async function listSessionLogs(
  client: SessionLogClient,
  io: CommandIO,
  positionals: readonly string[],
  isJson: boolean,
): Promise<void> {
  const [name, session] = positionals;

  if (name === undefined || positionals.length > 2) {
    throw new UsageError(LOGS_USAGE);
  }

  await requireFeatures(client, { sessionLog: 'list no logs' });

  const logs = await client.sessions.logs({ name, ...(session !== undefined && { session }) });

  io.print(formatOutput(logs, isJson, formatSessionLogs));
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

// Writes the raw output from `--from` to the log's end on stdout; a range
// the log lost goes to stderr, as the ring's gap would.
export async function writeSessionLog(
  client: SessionLogClient,
  io: CommandIO,
  positionals: readonly string[],
  from: number,
): Promise<void> {
  const [name, session, named] = positionals;

  if (name === undefined || session === undefined || positionals.length > 3) {
    throw new UsageError(LOG_USAGE);
  }

  let offset = from;

  await requireFeatures(client, { sessionLog: 'read no log' });

  const executionGeneration = await findGeneration(client, name, session, named);

  // the output of one generation only: a reader who named none learns which
  if (named === undefined) {
    io.printError(`impz: generation ${executionGeneration}`);
  }

  for (;;) {
    const read = await client.sessions.readLog({
      name,
      session,
      executionGeneration,
      from: offset,
    });

    if (read.gap !== undefined) {
      io.printError(
        `impz: bytes ${String(read.gap.from)} to ${String(read.gap.to)} are not in the log`,
      );
    }

    const buffer = await read.data.arrayBuffer();

    const data = new Uint8Array(buffer);

    if (data.byteLength === 0) {
      return;
    }

    io.writeOut(data);

    offset = read.offset + data.byteLength;
  }
}

export async function removeSessionLogs(
  client: SessionLogClient,
  io: CommandIO,
  positionals: readonly string[],
): Promise<void> {
  const [name, session, executionGeneration] = positionals;

  if (name === undefined || positionals.length > 3) {
    throw new UsageError(LOG_RM_USAGE);
  }

  await requireFeatures(client, { sessionLog: 'delete no log' });

  const result = await client.sessions.deleteLog({
    name,
    ...(session !== undefined && { session }),
    ...(executionGeneration !== undefined && { executionGeneration }),
  });

  io.print(`deleted ${String(result.deleted)} session logs of ${name}`);
}
