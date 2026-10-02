import { expect, test } from 'bun:test';
import { checkLimit } from '../lib/check-limit';
import { config } from '../lib/config';
import { runConsole } from '../lib/console';
import {
  readInfo,
  readState,
  requireImp,
  runImp,
  runInImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { registerImp, removeImps } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { writeMetric } from '../lib/write-metric';

const prefix = setupSuite('lifecycle');
const name = `${prefix}a`;

test('imp new boots the default image and the first exec answers within the limit', async () => {
  registerImp(name);

  const started = Date.now();

  const out = await runImp('new', name);

  await runInImp(name, 'true');

  const ms = Date.now() - started;

  writeMetric('newPlusExecMs', ms);
  checkLimit('imp new + first exec', ms, config.maxNewMs);

  const row = await requireImp(name);
  const urls = await runImp('url', name);
  const uname = await runInImp(name, 'uname', '-a');
  const info = await readInfo();

  expect(out.trim()).toBe(`${name} ${row.url}`);
  expect(row.url).toMatch(new RegExp(`^http://${name}\\.imp\\.localhost:\\d+$`));
  expect(row.state).toBe('running');
  expect(urls.split('\n')[0]).toBe(row.url);
  expect(uname).toStartWith(`Linux ${name} `);
  expect(info.impCount).toBeGreaterThanOrEqual(1);
});

test('exec passes stdout, stdin, stderr and exit codes through', async () => {
  const echoed = await runInImp(name, 'echo', 'hello-stdout');

  expect(echoed).toBe('hello-stdout');

  const stdin = await tryImp(['exec', name, '--', 'cat'], { stdin: 'hello stdin\n' });

  expect(stdin.stdout).toBe('hello stdin\n');

  const lines = Array.from({ length: 20_000 }, (_, index) => String(index + 1)).join('\n');

  const large = await tryImp(['exec', name, '--', 'wc', '-l'], { stdin: `${lines}\n` });

  expect(large.stdout.trim()).toBe('20000');

  const failed = await tryImp(['exec', name, '--', 'sh', '-c', 'echo to-stderr >&2; exit 7']);

  expect(failed).toMatchObject({ exitCode: 7, stdout: '', stderr: 'to-stderr\n' });

  const signalled = await tryImp(['exec', name, '--', 'sh', '-c', 'kill -TERM $$']);

  expect(signalled.exitCode).toBe(143);

  const missing = await tryImp(['exec', name, '--', '/no/such/binary']);

  expect(missing.exitCode).toBe(127);
});

test('exec -t runs the command on a pseudo-terminal', async () => {
  const out = await runImp('exec', '-t', name, '--', 'sh', '-c', 'tty; stty size');

  expect(out.replaceAll('\r', '')).toMatch(/^\/dev\/pts\/\d+\n\d+ \d+\n$/);
});

test('console runs commands in a shell and returns its exit code', async () => {
  const session = await runConsole(name, [
    { afterMs: 0, line: 'echo console-$((40 + 2))' },
    { afterMs: 1500, line: 'exit 5' },
  ]);

  expect(session.output).toContain('console-42');
  expect(session.exitCode).toBe(5);
});

test('the guest resolves names and reaches the internet', async () => {
  // bash's /dev/tcp: the default image may have no HTTP client
  const request = String.raw`printf "HEAD / HTTP/1.0\r\nHost: example.com\r\n\r\n" >&3`;

  const status = await runInImp(
    name,
    'bash',
    '-c',
    `getent hosts example.com >/dev/null && exec 3<>/dev/tcp/example.com/80 && ${request} && head -1 <&3`,
  );

  expect(status).toMatch(/^HTTP\/1\.[01] 200 /);
});

test('stop keeps the disk, exec boots a stopped imp and /run starts empty', async () => {
  await runShellInImp(name, `echo ${name}-data > /root/persist && touch /run/stale && sync`);
  await runImp('stop', name);

  const stopped = await readState(name);

  expect(stopped).toBe('stopped');

  // exec boots a stopped imp, as an HTTP request does (DESIGN.md 2.8)
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

  expect(restarted).toBe(`${name}-data`);

  console.log(`    start + exec: ${String(Date.now() - started)} ms`);
});

test('rm removes the imp and its network device', async () => {
  const row = await requireImp(name);

  await removeImps(name);

  const listed = await runImp('ls');
  const tap = await runInContainer(['ip', 'link', 'show', `imp${String(row.slot)}`]);

  expect(listed.split('\n').some((line) => line.startsWith(`${name} `))).toBeFalse();
  expect(tap.exitCode).not.toBe(0);
});
