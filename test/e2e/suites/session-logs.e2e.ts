import { expect, test } from 'bun:test';
import * as z from 'zod';
import { openSessionSocket, requireOutput } from '../lib/exec-socket';
import { resolveImageName } from '../lib/fixtures';
import { assertState, runImp, runInImp, tryImp } from '../lib/imp-cli';
import { createImp } from '../lib/imps';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// Session logs (docs/guides/session-logs.md): impd keeps the output of a
// session started with `log` on the host, past the agent's ring and past
// the end of the generation.

const prefix = setupSuite('session-logs');
const BARE = resolveImageName('e2e-bare');
const name = `${prefix}a`;
const MIB = 1_048_576;
const RING_BYTES = 262_144;
const TAIL = 1000;

// 1 MiB untouched by the tty, then, once /tmp/go exists, 1000 more bytes and
// exit 7: the wait lets a test sleep and wake the imp between the two
const PRODUCER = [
  'sh',
  '-c',
  [
    'stty -opost -echo',
    `head -c ${String(MIB)} /dev/zero | tr '\\0' x`,
    'while [ ! -e /tmp/go ]; do sleep 0.2; done',
    `head -c ${String(TAIL)} /dev/zero | tr '\\0' y`,
    'exit 7',
  ].join('; '),
];

const SessionLogRowSchema = z.object({
  session: z.string(),
  executionGeneration: z.string(),
  state: z.enum(['live', 'ended']),
  logStart: z.number(),
  logEnd: z.number(),
  bytes: z.number(),
  end: z.number().optional(),
  exitCode: z.number().nullable().optional(),
  complete: z.boolean(),
});

const seen = { generation: '' };

async function listLogs(): Promise<z.infer<typeof SessionLogRowSchema>[]> {
  const stdout = await runImp('sessions', 'logs', name, '--json');

  return z.array(SessionLogRowSchema).parse(JSON.parse(stdout));
}

async function findLog() {
  const logs = await listLogs();

  return logs.find((log) => log.executionGeneration === seen.generation);
}

test('impd says it keeps session logs', async () => {
  const stdout = await runImp('info', '--json');

  const info = z
    .object({ features: z.object({ sessionLog: z.boolean().optional() }).optional() })
    .parse(JSON.parse(stdout));

  expect(info.features?.sessionLog).toBe(true);
});

test('a logged session keeps all of 1 MiB, four times the ring', async () => {
  await createImp(name, '--image', BARE, '--memory', '256');

  const opening = performance.now();

  const producer = await openSessionSocket({
    type: 'start',
    name,
    session: 'out',
    argv: PRODUCER,
    tty: true,
    log: true,
  });

  const started = requireOutput(producer);

  seen.generation = started.executionGeneration;

  producer.close();

  const log = await waitFor('the whole 1 MiB in the log', async () => {
    const found = await findLog();

    if (found?.logEnd !== MIB) {
      throw new Error(`the log ends at ${String(found?.logEnd)}`);
    }

    return found;
  });

  writeMetric('session_log_mib_ms', Math.round(performance.now() - opening));

  expect(started.log).toEqual({ enabled: true });
  expect(log).toMatchObject({ session: 'out', state: 'live', logStart: 0, bytes: MIB });

  // the ring holds only the last 256 KiB; the log has the first byte
  const read = await runImp('sessions', 'log', name, 'out');

  expect(read.length).toBe(MIB);
  expect(/^x+$/.test(read)).toBeTrue();
  expect(MIB).toBeGreaterThan(RING_BYTES);
});

test('a sleep and a wake lose nothing: the log goes on, and the exit ends it', async () => {
  await runImp('sleep', name);
  await assertState(name, 'sleeping');

  // the exec wakes the imp; the session writes its tail and exits
  await runInImp(name, 'touch', '/tmp/go');

  const log = await waitFor('the exit in the log', async () => {
    const found = await findLog();

    if (found?.state !== 'ended') {
      throw new Error(`the log is ${String(found?.state)}`);
    }

    return found;
  });

  expect(log).toMatchObject({
    logStart: 0,
    logEnd: MIB + TAIL,
    end: MIB + TAIL,
    exitCode: 7,
    complete: true,
  });

  const tail = await runImp('sessions', 'log', name, 'out', '--from', String(MIB));

  expect(tail).toBe('y'.repeat(TAIL));
});

test('a stopped imp keeps its logs, and reading them boots nothing', async () => {
  await runImp('stop', name);

  const read = await runImp('sessions', 'log', name, 'out', seen.generation, '--from', '0');

  await assertState(name, 'stopped');

  expect(read.length).toBe(MIB + TAIL);
});

test('a checkpoint restore keeps the logs, which live on the host', async () => {
  await runImp('start', name);
  await runImp('checkpoint', name, 'before');
  await runImp('restore', name, 'before');

  const log = await findLog();

  expect(log?.complete).toBeTrue();
});

test('a session without log keeps none, and log-rm deletes the logs', async () => {
  const plain = await openSessionSocket({
    type: 'start',
    name,
    session: 'plain',
    argv: ['sh', '-c', 'echo hi; exec sleep 3600'],
    tty: true,
  });

  const started = requireOutput(plain);

  plain.close();

  expect(started.log).toBeUndefined();

  const logs = await listLogs();

  expect(logs.map((log) => log.session)).toEqual(['out']);

  const removed = await runImp('sessions', 'log-rm', name);

  expect(removed.trim()).toBe(`deleted 1 session logs of ${name}`);

  const after = await listLogs();

  expect(after).toEqual([]);

  const missing = await tryImp(['sessions', 'log', name, 'out', seen.generation]);

  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain('no log of session out');
});
