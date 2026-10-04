import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { SessionLog } from '@imp/api';
import type { ImpClient } from '../create-imp-client';
import { UsageError } from '../usage-error';
import { listSessionLogs, removeSessionLogs, writeSessionLog } from './session-logs';

afterEach(() => {
  mock.restore();
});

const GENERATION = 'c'.repeat(32);

const LOG: SessionLog = {
  session: 'main',
  executionGeneration: GENERATION,
  bootId: 'boot-1',
  state: 'ended',
  logStart: 4,
  logEnd: 10,
  bytes: 6,
  end: 10,
  exitCode: 0,
  complete: false,
  startedAt: new Date('2026-10-04T00:00:00.000Z'),
  endedAt: new Date('2026-10-04T00:01:00.000Z'),
};

// an impd with session logs whose one log holds "abcdef" at [4, 10)
const WITH_LOGS: Readonly<Record<string, boolean>> = { sessionLog: true };

function buildClient(features = WITH_LOGS) {
  const reads: number[] = [];
  const deletes: unknown[] = [];

  const bytes = new TextEncoder().encode('abcdef');

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fake of the two namespaces the verbs call
  const client = {
    system: { info: () => Promise.resolve({ features }) },
    sessions: {
      logs: () => Promise.resolve([LOG]),
      readLog: (input: Readonly<{ from: number }>) => {
        reads.push(input.from);

        const offset = Math.max(input.from, 4);
        const data = bytes.subarray(offset - 4, Math.min(offset - 4 + 4, 6));

        return Promise.resolve({
          offset,
          ...(input.from < 4 && { gap: { from: input.from, to: 4 } }),
          data: new Blob([data]),
          log: LOG,
        });
      },
      deleteLog: (input: unknown) => {
        deletes.push(input);

        return Promise.resolve({ deleted: 1 });
      },
    },
  } as unknown as Pick<ImpClient, 'sessions' | 'system'>;

  return { client, reads, deletes };
}

test('log writes the newest log to stdout, and a gap to stderr', async () => {
  const ctx = buildClient();
  const written: string[] = [];

  spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);

    written.push(text);

    return true;
  });

  const errors = spyOn(console, 'error').mockImplementation(() => {});

  await writeSessionLog(ctx.client, ['dev', 'main'], undefined);

  expect(written.join('')).toBe('abcdef');
  expect(ctx.reads).toEqual([0, 8, 10]);
  expect(errors).toHaveBeenCalledWith('imp: bytes 0 to 4 are not in the log');
  expect(errors).toHaveBeenCalledWith(`imp: generation ${GENERATION}`);
});

test('log takes --from and refuses a bad one', async () => {
  const ctx = buildClient();

  spyOn(process.stdout, 'write').mockImplementation(() => true);

  await writeSessionLog(ctx.client, ['dev', 'main', GENERATION], '6');

  expect(ctx.reads).toEqual([6, 10]);

  const bad = await writeSessionLog(ctx.client, ['dev', 'main'], '-1').catch(
    (error: unknown) => error,
  );

  expect(bad).toBeInstanceOf(UsageError);
});

test('an impd without session logs is refused before any read', async () => {
  const ctx = buildClient({});

  const refused = await writeSessionLog(ctx.client, ['dev', 'main'], undefined).catch(
    (error: unknown) => error,
  );

  expect(String(refused)).toContain('this impd has no session logs');
  expect(ctx.reads).toEqual([]);
});

test('logs lists, and log-rm deletes what it names', async () => {
  const ctx = buildClient();
  const printed = spyOn(console, 'log').mockImplementation(() => {});

  await listSessionLogs(ctx.client, ['dev'], false);

  expect(String(printed.mock.calls[0]?.[0])).toContain(GENERATION);

  await removeSessionLogs(ctx.client, ['dev', 'main']);

  expect(ctx.deletes).toEqual([{ name: 'dev', session: 'main' }]);
  expect(printed).toHaveBeenLastCalledWith('deleted 1 session logs of dev');
});
