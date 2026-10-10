import { expect, onTestFinished, test } from 'bun:test';
import * as z from 'zod';
import { config } from '../lib/config';
import { openSessionSocket, requireOutput } from '../lib/exec-socket';
import { resolveImageName } from '../lib/fixtures';
import {
  assertState,
  createInstanceClient,
  readState,
  runImp,
  runInImp,
  tryImp,
} from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { listSessionLogs, requireSessionLog } from '../lib/session-logs';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// Session logs (docs/guides/session-logs.md): impd keeps the output of a
// session started with `log` on the host, past the agent's ring (256 KiB)
// and past the end of the generation.

// one stack for every release, so each session socket closes before its imp
// goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('session-logs'), stack, client };
}

test('it says impd keeps session logs', async () => {
  const stdout = await runImp('info', '--json');

  const info = z
    .object({ features: z.object({ sessionLog: z.boolean().optional() }).optional() })
    .parse(JSON.parse(stdout));

  expect(info.features?.sessionLog).toBe(true);
});

test('it keeps all of a logged session past the ring, a sleep and a wake, the exit, a stop and a restore', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}a`;
  const mib = 1_048_576;
  const tail = 1000;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const opening = performance.now();

  // 1 MiB untouched by the tty, then, once /tmp/go exists, 1000 more bytes
  // and exit 7: the wait lets the journey sleep and wake the imp between
  const producer = await openSessionSocket({
    type: 'start',
    name,
    session: 'out',
    argv: [
      'sh',
      '-c',
      [
        'stty -opost -echo',
        `head -c ${String(mib)} /dev/zero | tr '\\0' x`,
        'while [ ! -e /tmp/go ]; do sleep 0.2; done',
        `head -c ${String(tail)} /dev/zero | tr '\\0' y`,
        'exit 7',
      ].join('; '),
    ],
    tty: true,
    log: true,
  });

  ctx.stack.defer(() => {
    producer.close();
  });

  const started = requireOutput(producer);

  producer.close();

  // all of 1 MiB, four times the ring, from the first byte on
  const full = await waitFor('the whole 1 MiB in the log', async () => {
    const log = await requireSessionLog(name, started.executionGeneration);

    if (log.logEnd !== mib) {
      throw new Error(`the log ends at ${String(log.logEnd)}`);
    }

    return log;
  });

  writeMetric('session_log_mib_ms', Math.round(performance.now() - opening));

  const read = await runImp('sessions', 'log', name, 'out');

  expect(started.log).toStrictEqual({ enabled: true });
  expect(full).toMatchObject({ session: 'out', state: 'live', logStart: 0, bytes: mib });
  expect(read).toBe('x'.repeat(mib));

  // a sleep and a wake lose nothing: the log goes on, and the exit ends it
  await runImp('sleep', name);
  await assertState(name, 'sleeping');

  // the exec wakes the imp; the session writes its tail and exits
  await runInImp(name, 'touch', '/tmp/go');

  const ended = await waitFor('the exit in the log', async () => {
    const log = await requireSessionLog(name, started.executionGeneration);

    if (log.state !== 'ended') {
      throw new Error(`the log is ${log.state}`);
    }

    return log;
  });

  const tailRead = await runImp('sessions', 'log', name, 'out', '--from', String(mib));

  expect(ended).toMatchObject({
    logStart: 0,
    logEnd: mib + tail,
    end: mib + tail,
    exitCode: 7,
    complete: true,
  });

  expect(tailRead).toBe('y'.repeat(tail));

  // a stopped imp keeps its logs, and reading them boots nothing
  await runImp('stop', name);

  const stoppedRead = await runImp(
    'sessions',
    'log',
    name,
    'out',
    started.executionGeneration,
    '--from',
    '0',
  );

  const stoppedState = await readState(name);

  expect(stoppedRead).toBe(`${'x'.repeat(mib)}${'y'.repeat(tail)}`);
  expect(stoppedState).toBe('stopped');

  // a checkpoint restore keeps the logs, which live on the host
  await runImp('start', name);
  await runImp('checkpoint', name, 'before');
  await runImp('restore', name, 'before');

  const restored = await requireSessionLog(name, started.executionGeneration);

  expect(restored.complete).toBeTrue();
  expect(restored.logEnd).toBe(mib + tail);
});

test('it keeps no log of a session started without log, and log-rm deletes the logs', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}rm`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const logged = await openSessionSocket({
    type: 'start',
    name,
    session: 'out',
    argv: ['sh', '-c', 'echo logged; exit 0'],
    tty: true,
    log: true,
  });

  ctx.stack.defer(() => {
    logged.close();
  });

  const loggedOutput = requireOutput(logged);

  logged.close();

  await waitFor('the logged session to end', async () => {
    const log = await requireSessionLog(name, loggedOutput.executionGeneration);

    if (log.state !== 'ended') {
      throw new Error(`the log is ${log.state}`);
    }
  });

  const plain = await openSessionSocket({
    type: 'start',
    name,
    session: 'plain',
    argv: ['sh', '-c', 'echo hi; exec sleep 3600'],
    tty: true,
  });

  ctx.stack.defer(() => {
    plain.close();
  });

  const plainOutput = requireOutput(plain);

  plain.close();

  const logs = await listSessionLogs(name);
  const removed = await runImp('sessions', 'log-rm', name);
  const after = await listSessionLogs(name);
  const missing = await tryImp(['sessions', 'log', name, 'out', loggedOutput.executionGeneration]);

  expect(plainOutput.log).toBeUndefined();
  expect(logs.map((log) => log.session)).toStrictEqual(['out']);
  expect(removed).toBe(`deleted 1 session logs of ${name}\n`);
  expect(after).toStrictEqual([]);

  expect(missing).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('no log of session out'),
  });
});
