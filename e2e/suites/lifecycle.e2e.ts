import { expect, onTestFinished, test } from 'bun:test';
import { checkLimit } from '../lib/check-limit';
import { config } from '../lib/config';
import { runConsole } from '../lib/console';
import {
  createInstanceClient,
  parseImp,
  readImpUrls,
  readInfo,
  readState,
  requireImp,
  runImp,
  runInImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { writeMetric } from '../lib/write-metric';

// An imp of the default image through its life: create, exec, console,
// network, stop and start, rm. Each test boots its own; the event stream is
// in lifecycle-events.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('lifecycle'), stack, client };
}

test('it boots the default image on impz new and answers the first exec within the limit', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}a`;
  const started = Date.now();

  const out = await runImp('new', name, '--json');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await runInImp(name, 'true');

  const ms = Date.now() - started;

  writeMetric('newPlusExecMs', ms);
  checkLimit('impz new + first exec', ms, config.maxNewMs);

  const row = await requireImp(name);
  const urls = await readImpUrls(name);
  const uname = await runInImp(name, 'uname', '-a');
  const info = await readInfo();

  const created = parseImp(out);

  expect(created.name).toBe(name);
  expect(created.url).toBe(row.url);
  expect(row.url).toMatch(new RegExp(`^http://${name}\\.imp\\.localhost:\\d+$`, 'u'));
  expect(row.state).toBe('running');
  expect(urls.local).toBe(row.url);
  expect(uname).toStartWith(`Linux ${name} `);
  expect(info.impCount).toBeGreaterThanOrEqual(1);
});

test('it passes stdout, stdin, stderr and exit codes through exec', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}io`;

  await runImp('new', name);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const echoed = await runInImp(name, 'echo', 'hello-stdout');
  const stdin = await tryImp(['exec', name, '--', 'cat'], { stdin: 'hello stdin\n' });

  const lines = Array.from({ length: 20_000 }, (_, index) => String(index + 1)).join('\n');

  const large = await tryImp(['exec', name, '--', 'wc', '-l'], { stdin: `${lines}\n` });
  const failed = await tryImp(['exec', name, '--', 'sh', '-c', 'echo to-stderr >&2; exit 7']);
  const signalled = await tryImp(['exec', name, '--', 'sh', '-c', 'kill -TERM $$']);
  const missing = await tryImp(['exec', name, '--', '/no/such/binary']);

  expect(echoed).toBe('hello-stdout');
  expect(stdin).toStrictEqual({ exitCode: 0, stdout: 'hello stdin\n', stderr: '' });
  expect(large).toStrictEqual({ exitCode: 0, stdout: '20000\n', stderr: '' });
  expect(failed).toStrictEqual({ exitCode: 7, stdout: '', stderr: 'to-stderr\n' });
  expect(signalled.exitCode).toBe(143);
  expect(missing.exitCode).toBe(127);
});

test('it runs exec -t on a pseudo-terminal', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}tty`;

  await runImp('new', name);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const out = await runImp('exec', '-t', name, '--', 'sh', '-c', 'tty; stty size');

  expect(out.replaceAll('\r', '')).toMatch(/^\/dev\/pts\/\d+\n\d+ \d+\n$/u);
});

test('it runs commands in a console shell and returns its exit code', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}con`;

  await runImp('new', name);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const session = await runConsole(name, [
    { after: null, line: 'echo console-$((40 + 2))' },
    { after: 'console-42', line: 'exit 5' },
  ]);

  expect(session.output).toContain('console-42');
  expect(session.exitCode).toBe(5);
});

test('it resolves names and reaches the internet from the guest', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}net`;

  await runImp('new', name);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  // bash's /dev/tcp: the default image may have no HTTP client
  const request = String.raw`printf "HEAD / HTTP/1.0\r\nHost: example.com\r\n\r\n" >&3`;

  const status = await runInImp(
    name,
    'bash',
    '-c',
    `getent hosts example.com >/dev/null && exec 3<>/dev/tcp/example.com/80 && ${request} && head -1 <&3`,
  );

  expect(status).toMatch(/^HTTP\/1\.[01] 200 /u);
});

test('it keeps the disk through a stop, boots a stopped imp on exec with an empty /run, and again on start', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}stop`;

  await runImp('new', name);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runShellInImp(name, `echo ${name}-data > /root/persist && touch /run/stale && sync`);
  await runImp('stop', name);

  const stopped = await readState(name);

  expect(stopped).toBe('stopped');

  // exec boots a stopped imp, as an HTTP request does
  // (docs/architecture/lifecycle/sleep-and-wake.md#what-survives-a-sleep)
  const persisted = await runInImp(name, 'cat', '/root/persist');
  const booted = await readState(name);
  const run = await runShellInImp(name, 'test -e /run/stale && echo stale || echo fresh');

  expect(persisted).toBe(`${name}-data`);
  expect(booted).toBe('running');
  expect(run).toBe('fresh');

  await runImp('stop', name);

  const started = Date.now();

  await runImp('start', name);

  const restarted = await runInImp(name, 'cat', '/root/persist');

  writeMetric('startPlusExecMs', Date.now() - started);

  expect(restarted).toBe(`${name}-data`);
});

test('it removes the imp and its network device on rm', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}rm`;

  await runImp('new', name);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const row = await requireImp(name);

  const device = `imp${String(row.slot)}`;

  await runImp('rm', name);

  const listed = await runImp('ls');
  const tap = await runInContainer(['ip', 'link', 'show', device]);

  expect(listed).not.toMatch(new RegExp(`^${name} `, 'mu'));

  expect(tap).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `Device "${device}" does not exist.\n`,
  });
});
