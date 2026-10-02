import { expect, test } from 'bun:test';
import * as z from 'zod';
import { checkLimit } from '../lib/check-limit';
import { config } from '../lib/config';
import { runConsole } from '../lib/console';
import {
  parseImp,
  readImpUrls,
  readInfo,
  readState,
  requireImp,
  runImp,
  runInImp,
  runShellInImp,
  startImp,
  tryImp,
} from '../lib/imp-cli';
import { createImp, registerImp, removeImps } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

const prefix = setupSuite('lifecycle');
const name = `${prefix}a`;
const eventsName = `${prefix}ev`;
const anchorName = `${prefix}anchor`;

const EventLineSchema = z.object({
  ev: z.string(),
  reason: z.string().optional(),
  name: z.string().optional(),
  imp: z.object({ name: z.string() }).optional(),
});

// Each line `imp events` prints, as `name ev reason`, to `onLine` as it comes;
// the governor's decisions are left out, since they depend on what else is
// awake.
async function collectEvents(
  stdout: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();

  let buffered = '';

  for await (const chunk of stdout) {
    buffered += decoder.decode(chunk, { stream: true });

    const lines = buffered.split('\n');

    buffered = lines.pop() ?? '';

    for (const line of lines) {
      const event = EventLineSchema.parse(JSON.parse(line));

      if (event.ev !== 'GovernorDecision') {
        const words = [event.imp?.name ?? event.name, event.ev, event.reason];

        onLine(words.filter((word) => word !== undefined).join(' '));
      }
    }
  }
}

test('imp new boots the default image and the first exec answers within the limit', async () => {
  registerImp(name);

  const started = Date.now();

  const out = await runImp('new', name, '--json');

  await runInImp(name, 'true');

  const ms = Date.now() - started;

  writeMetric('newPlusExecMs', ms);
  checkLimit('imp new + first exec', ms, config.maxNewMs);

  const row = await requireImp(name);
  const urls = await readImpUrls(name);
  const uname = await runInImp(name, 'uname', '-a');
  const info = await readInfo();

  const created = parseImp(out);

  expect(created.name).toBe(name);
  expect(created.url).toBe(row.url);
  expect(row.url).toMatch(new RegExp(`^http://${name}\\.imp\\.localhost:\\d+$`));
  expect(row.state).toBe('running');
  expect(urls.local).toBe(row.url);
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

test('imp events streams a create, sleep, wake and rm, and the api audit log has them', async () => {
  // an imp already there, whose snapshot line says the stream is open
  await createImp(anchorName, '--memory', '512');

  registerImp(eventsName);

  const events = await startImp(['events']);

  const seen: string[] = [];

  const collecting = collectEvents(events.stdout, (line) => {
    seen.push(line);
  });

  try {
    await waitFor('the snapshot from imp events', () => {
      expect(seen).toContain(`${anchorName} ImpAdded snapshot`);
    });

    await runImp('new', eventsName, '--memory', '512');
    await runImp('sleep', eventsName);
    await runImp('wake', eventsName);
    await runImp('rm', eventsName);

    await waitFor('the rm in imp events', () => {
      expect(seen).toContain(`${eventsName} ImpRemoved`);
    });
  } finally {
    events.kill();

    await collecting;
    await removeImps(anchorName);
  }

  expect(seen.filter((line) => line.startsWith(`${eventsName} `))).toEqual([
    `${eventsName} ImpAdded created`,
    `${eventsName} ImpChanged booted`,
    `${eventsName} ImpChanged slept`,
    `${eventsName} ImpChanged woke`,
    `${eventsName} ImpRemoved`,
  ]);

  const audit = await runImp('audit', eventsName, '--kind', 'api', '--json');

  const calls = z
    .array(z.object({ procedure: z.string(), actor: z.string() }))
    .parse(JSON.parse(audit))

    // newest first; a reused dev instance keeps the rows of earlier runs
    .slice(0, 4);

  expect(calls.map((call) => call.procedure)).toEqual([
    'imps.destroy',
    'imps.wake',
    'imps.sleep',
    'imps.create',
  ]);

  expect(calls.every((call) => call.actor === 'token')).toBeTrue();
});
