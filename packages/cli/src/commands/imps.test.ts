import { expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockImp } from '@imp/api/test-utils/build-mock-imp';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { writeHostConfig } from '../host-store';
import { runCli } from '../test-utils/start-cli';
import { startStubImpd } from '../test-utils/start-stub-impd';
import { listAllImps, listForkWarnings, readConsoleSession } from './imps';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-imps-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const owned = stack.move();

  // the CLI's home, where config.json keeps the saved hosts, so none of
  // this machine's reaches it
  const home = { HOME: dir, XDG_CONFIG_HOME: dir };

  return { home, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('#listForkWarnings names each grant the fork did not get', () => {
  const fork = {
    name: 'dev-b',
    grantsNotCopied: [
      { secret: 'gh', reason: 'not-grantable' as const },
      { secret: 'npm', reason: 'clash' as const },
    ],
  };

  expect(listForkWarnings('dev-a', fork)).toStrictEqual([
    'dev-b: grant gh of dev-a not copied: not-grantable',
    'dev-b: grant npm of dev-a not copied: clash',
  ]);
});

test('#listForkWarnings names a copy of the grants that failed as a whole', () => {
  const fork = { name: 'dev-b', grantsNotCopied: [], grantsError: 'the copy failed' };

  expect(listForkWarnings('dev-a', fork)).toStrictEqual(['dev-b: the copy failed']);
});

test('#listForkWarnings warns of nothing for a fork from an impd that predates the report', () => {
  expect(listForkWarnings('dev-a', { name: 'dev-b' })).toBeEmpty();
});

test('#new refuses a size that is not a whole positive number', async () => {
  const result = await runCli({
    args: ['new', 'box', '--memory', '1.5g'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: not a size: 1.5g (try 512m, 2g, 1t, or MiB as a whole number)\n',
    code: 2,
  });
});

test('#new refuses an IMP_URL that is not an http URL', async () => {
  const result = await runCli({ args: ['new', 'box'], env: { IMP_URL: 'localhost:7070' } });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: IMP_URL is not an http(s) URL: localhost:7070\n',
    code: 2,
  });
});

test('#console refuses a detach key that is not ctrl-<key>', async () => {
  const result = await runCli({
    args: ['console', 'box', '--detach-key', 'esc'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: String.raw`imp: --detach-key takes ctrl-<key> (a-z but h, i, j and m; @, \, ], ^ or _) or none, got esc
`,
    code: 2,
  });
});

test('#console refuses an empty session name', async () => {
  const result = await runCli({
    args: ['console', 'box', '--session', ''],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: 'imp: a session needs a name\n', code: 2 });
});

test.each([
  ['no session on a terminal', undefined, true, 'main'],
  ['no session off a terminal', undefined, false, null],
  ['a named session off a terminal', 'work', false, 'work'],
  ['--no-session on a terminal', false, true, null],
] as const)(
  '#readConsoleSession picks the console session for %s',
  (_case, session, isTerminal, expected) => {
    expect(readConsoleSession(session, isTerminal)).toBe(expected);
  },
);

test.each([
  [
    ['exec', 'box', '--require', 'network', '--', 'true'],
    'imp: --require takes broker; not network\n',
  ],
  [
    ['exec', 'box', '--agent', '--require', 'broker', '--', 'true'],
    'imp: --require does not go with --agent: an exec in the agent gets no broker\n',
  ],
])('#exec refuses %p before any call to impd', async (args, stderr) => {
  await using ctx = await setupTest();

  using impd = startStubImpd({ token: 'imps-token' });

  const result = await runCli({
    args,
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'imps-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result).toStrictEqual({ stdout: '', stderr, code: 2 });
  expect(impd.calls).toStrictEqual([]);
});

test('#exec runs nothing for --require on an impd older than 0.30.0', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'imps-token',
    answers: {
      'system/info': {
        version: '0.29.0',
        features: {
          sessionOffsets: true,
          leases: true,
          grantableTokens: true,
          secretRebind: true,
          secretFilesGc: true,
          tokenUpdate: true,
        },
      },
    },
  });

  const result = await runCli({
    args: ['exec', 'box', '--require', 'broker', '--', 'true'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'imps-token' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'imp: this impd is older than 0.30.0 and would run the command without checking --require; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info']);
});

test('#console refuses --log without a session before any call to impd', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({ token: 'imps-token' });

  const result = await runCli({
    args: ['console', 'dev', '--no-session', '--log'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'imps-token' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: 'imp: --log needs a session\n', code: 2 });
  expect(impd.calls).toStrictEqual([]);
});

// an impd from before session logs
test('#console makes no call past the feature check for --log on an impd without session logs', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'imps-token',
    answers: {
      'system/info': { version: '0.26.0', features: { sessionOffsets: true, leases: true } },
    },
  });

  const result = await runCli({
    args: ['console', 'dev', '--session', 'main', '--log'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'imps-token' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'imp: this impd has no session logs and would start the session without a log; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info']);
});

test('#ls lists every saved host and exits 3 when one of them fails', async () => {
  await using ctx = await setupTest();

  // db is on its way to another host
  using box = startStubImpd({
    token: 'imps-token',
    answers: {
      'imps/list': [
        buildMockImp({ name: 'web', state: 'running', move: 'receiving' }),
        buildMockImp({ name: 'db', state: 'running', move: 'sending' }),
      ],
    },
  });

  using laptop = startStubImpd({
    token: 'imps-token',
    answers: { 'imps/list': [buildMockImp({ name: 'dev', state: 'sleeping' })] },
  });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'imps-token' },
      laptop: { url: laptop.url, token: 'imps-token' },
      gone: { url: 'http://127.0.0.1:1', token: 'imps-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all'], env: ctx.home });

  const rows = listed.stdout.trimEnd().split('\n');

  expect(rows.map((row) => row.split(/\s+/u).slice(0, 3))).toStrictEqual([
    ['HOST', 'NAME', 'STATE'],
    ['box', 'web', 'running'],
    ['box', 'db', 'running'],
    ['laptop', 'dev', 'sleeping'],
  ]);

  expect(rows[2]).toInclude('  sending');
  expect(listed.stderr).toMatch(/^imp: gone: [^\n]+\n$/u);
  expect(listed.code).toBe(3);
});

test('#listAllImps gives up after 5 s on a host that never answers, as a stalled impd does', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({
    token: 'imps-token',
    answers: { 'imps/list': [buildMockImp({ name: 'web', state: 'running' })] },
  });

  // takes the connection and never answers, as a sleeping laptop's impd
  // does from behind a stalled tailnet path
  using silent = startStubImpd({ token: 'imps-token', isSilent: true });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'imps-token' },
      silent: { url: silent.url, token: 'imps-token' },
    },
  });

  const timers: { ms: number; fire: () => void; isCancelled: boolean }[] = [];
  const print = mock<(line: string) => void>();
  const printError = mock<(line: string) => void>();

  const listing = listAllImps({
    env: ctx.home,
    isJson: false,
    hasBuilders: false,
    print,
    printError,
    startTimer: (ms, fire) => {
      const timer = { ms, fire, isCancelled: false };

      timers.push(timer);

      return () => {
        timer.isCancelled = true;
      };
    },
  });

  // box answered, so only the silent host's timer still runs; the hosts go
  // in name order
  await waitFor(() => {
    expect(timers.map((timer) => timer.isCancelled)).toStrictEqual([true, false]);
  });

  const [, silentTimer] = timers;

  invariant(silentTimer);

  silentTimer.fire();

  const code = await listing;

  const table = print.mock.calls[0]?.[0];

  invariant(table);

  expect(
    table
      .trimEnd()
      .split('\n')
      .map((row) => row.split(/\s+/u).slice(0, 3)),
  ).toStrictEqual([
    ['HOST', 'NAME', 'STATE'],
    ['box', 'web', 'running'],
  ]);

  expect(timers.map((timer) => timer.ms)).toStrictEqual([5000, 5000]);
  expect(printError).toHaveBeenCalledExactlyOnceWith('imp: silent: no answer in 5 s');
  expect(code).toBe(3);
});

test('#ls never prints a saved token under --all', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({
    token: 'imps-secret-token',
    answers: { 'imps/list': [buildMockImp({ name: 'web' })] },
  });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'imps-secret-token' },
      gone: { url: 'http://127.0.0.1:1', token: 'imps-secret-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all'], env: ctx.home });

  expect(`${listed.stdout}${listed.stderr}`).not.toInclude('imps-secret-token');
});

test('#ls writes the imps and the errors of every host as JSON for --all --json', async () => {
  await using ctx = await setupTest();

  // db carries `host`, a field a newer impd's imp could carry and this
  // CLI's schema lacks, which must not replace the saved host's name
  const web = buildMockImp({ name: 'web' });
  const db = { ...buildMockImp({ name: 'db' }), host: 'peer' };
  const dev = buildMockImp({ name: 'dev' });

  using box = startStubImpd({
    token: 'imps-token',
    answers: { 'imps/list': [web, db] },
  });

  using laptop = startStubImpd({
    token: 'imps-token',
    answers: { 'imps/list': [dev] },
  });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'imps-token' },
      laptop: { url: laptop.url, token: 'imps-token' },
      gone: { url: 'http://127.0.0.1:1', token: 'imps-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all', '--json'], env: ctx.home });

  const body: unknown = JSON.parse(listed.stdout);

  // what the CLI receives, dates as JSON writes them
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(
    JSON.stringify([
      { ...web, host: 'box' },
      { ...db, host: 'box' },
      { ...dev, host: 'laptop' },
    ]),
  );

  expect(body).toStrictEqual({
    imps: sent,
    errors: [{ host: 'gone', message: expect.any(String) as unknown }],
  });

  expect(listed.code).toBe(3);
});

test('#ls writes an empty JSON list and exits 1 when no host answers --all --json', async () => {
  await using ctx = await setupTest();

  writeHostConfig(ctx.home, {
    current: 'gone',
    hosts: {
      gone: { url: 'http://127.0.0.1:1', token: 'imps-token' },
      away: { url: 'http://127.0.0.1:2', token: 'imps-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all', '--json'], env: ctx.home });

  const body: unknown = JSON.parse(listed.stdout);

  expect(body).toStrictEqual({
    imps: [],
    errors: [
      { host: 'away', message: expect.any(String) as unknown },
      { host: 'gone', message: expect.any(String) as unknown },
    ],
  });

  const failed: unknown = listed.stderr.trimEnd().split('\n');

  expect(failed).toStrictEqual([
    expect.stringMatching(/^imp: away: /u) as unknown,
    expect.stringMatching(/^imp: gone: /u) as unknown,
  ]);

  expect(listed.code).toBe(1);
});

test('#ls asks every host for its builders under --all --builders', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({ token: 'imps-token', answers: { 'imps/list': [] } });
  using laptop = startStubImpd({ token: 'imps-token', answers: { 'imps/list': [] } });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'imps-token' },
      laptop: { url: laptop.url, token: 'imps-token' },
    },
  });

  await runCli({ args: ['ls', '--all', '--builders'], env: ctx.home });

  expect([...box.calls, ...laptop.calls]).toStrictEqual([
    { path: 'imps/list', authorization: 'Bearer imps-token', input: { builders: true } },
    { path: 'imps/list', authorization: 'Bearer imps-token', input: { builders: true } },
  ]);
});

test('#ls asks no host for its builders under plain --all', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({ token: 'imps-token', answers: { 'imps/list': [] } });
  using laptop = startStubImpd({ token: 'imps-token', answers: { 'imps/list': [] } });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'imps-token' },
      laptop: { url: laptop.url, token: 'imps-token' },
    },
  });

  await runCli({ args: ['ls', '--all'], env: ctx.home });

  expect([...box.calls, ...laptop.calls]).toStrictEqual([
    { path: 'imps/list', authorization: 'Bearer imps-token', input: undefined },
    { path: 'imps/list', authorization: 'Bearer imps-token', input: undefined },
  ]);
});

test('#ls refuses --all with --host', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({ token: 'imps-token' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: 'imps-token' } },
  });

  const listed = await runCli({ args: ['--host', 'box', 'ls', '--all'], env: ctx.home });

  expect(listed).toStrictEqual({
    stdout: '',
    stderr: 'imp: --all lists every saved host; drop --host\n',
    code: 2,
  });

  expect(box.calls).toStrictEqual([]);
});

test('#new refuses --place with --host', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({ token: 'imps-token' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: 'imps-token' } },
  });

  const placed = await runCli({ args: ['--host', 'box', 'new', 'dev', '--place'], env: ctx.home });

  expect(placed).toStrictEqual({
    stdout: '',
    stderr: 'imp: --place picks among the saved hosts; drop --host\n',
    code: 2,
  });

  expect(box.calls).toStrictEqual([]);
});

test('#ls lists the current host alone without --all', async () => {
  await using ctx = await setupTest();

  // a field this CLI's schema lacks passes through as impd sent it
  const db = { ...buildMockImp({ name: 'db' }), host: 'peer' };

  using box = startStubImpd({ token: 'imps-token', answers: { 'imps/list': [db] } });
  using laptop = startStubImpd({ token: 'imps-token' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'imps-token' },
      laptop: { url: laptop.url, token: 'imps-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--json'], env: ctx.home });

  const body: unknown = JSON.parse(listed.stdout);

  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(JSON.stringify([db]));

  expect(body).toStrictEqual(sent);
  expect(listed.code).toBe(0);
  expect(laptop.calls).toStrictEqual([]);
});

test('#new skips a host without the image and moves past a RAM refusal under --place', async () => {
  await using ctx = await setupTest();

  const created = buildMockImp({ name: 'dev' });

  // the most RAM, but its governor refuses the create, as a full host's does
  using big = startStubImpd({
    token: 'imps-token',
    answers: {
      'imps/list': [],
      'images/list': [{ name: 'base' }],
      'tokens/whoami': { kind: 'token', name: 'root', scope: 'manage', imps: null },
      'system/info': {
        version: '0.12.0',
        ramBudgetMib: 32_768,
        ramUsedMib: 0,
        ramReservedMib: 0,
        ramSleepingMib: 0,
        storage: { isLow: false },
        defaults: { memoryMib: 512, image: 'base' },
        egress: { isEnforced: true },
      },
    },
    failures: {
      'imps/create': {
        defined: true,
        code: 'RAM_BUDGET_EXCEEDED',
        status: 503,
        message: 'Not enough RAM budget, even after sleeping idle imps',
        data: { budgetMib: 32_768, usedMib: 32_500, requestedMib: 512 },
      },
    },
  });

  using small = startStubImpd({
    token: 'imps-token',
    answers: {
      'imps/list': [],
      'images/list': [{ name: 'base' }],
      'tokens/whoami': { kind: 'token', name: 'root', scope: 'manage', imps: null },
      'system/info': {
        version: '0.12.0',
        ramBudgetMib: 8192,
        ramUsedMib: 0,
        ramReservedMib: 0,
        ramSleepingMib: 0,
        storage: { isLow: false },
        defaults: { memoryMib: 512, image: 'base' },
        egress: { isEnforced: true },
      },
      'imps/create': created,
    },
  });

  // the most RAM of all, but not the default image
  using bare = startStubImpd({
    token: 'imps-token',
    answers: {
      'imps/list': [],
      'images/list': [{ name: 'ubuntu' }],
      'tokens/whoami': { kind: 'token', name: 'root', scope: 'manage', imps: null },
      'system/info': {
        version: '0.12.0',
        ramBudgetMib: 65_536,
        ramUsedMib: 0,
        ramReservedMib: 0,
        ramSleepingMib: 0,
        storage: { isLow: false },
        defaults: { memoryMib: 512, image: 'base' },
        egress: { isEnforced: true },
      },
    },
  });

  writeHostConfig(ctx.home, {
    current: 'big',
    hosts: {
      big: { url: big.url, token: 'imps-token' },
      small: { url: small.url, token: 'imps-token' },
      bare: { url: bare.url, token: 'imps-token' },
    },
  });

  const placed = await runCli({ args: ['new', 'dev', '--place', '--json'], env: ctx.home });

  const body: unknown = JSON.parse(placed.stdout);

  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(JSON.stringify({ host: 'small', imp: created }));

  expect(placed.stderr).toBe(
    [
      'imp: bare: skipped: it has no image base',
      'imp: placing on big',
      'imp: big: Not enough RAM budget, even after sleeping idle imps; trying the next host',
      'imp: placing on small',
      '',
    ].join('\n'),
  );

  expect(body).toStrictEqual(sent);
  expect(placed.code).toBe(0);
  expect(big.calls.filter((call) => call.path === 'imps/create')).toHaveLength(1);

  expect(small.calls.filter((call) => call.path === 'imps/create')).toStrictEqual([
    { path: 'imps/create', authorization: 'Bearer imps-token', input: { name: 'dev' } },
  ]);

  expect(bare.calls.filter((call) => call.path === 'imps/create')).toBeEmpty();
});

test('#new refuses --place for a name a saved host has already', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({
    token: 'imps-token',
    answers: {
      'imps/list': [buildMockImp({ name: 'web' })],
      'images/list': [{ name: 'base' }],
      'tokens/whoami': { kind: 'token', name: 'root', scope: 'manage', imps: null },
      'system/info': {
        version: '0.12.0',
        ramBudgetMib: 8192,
        ramUsedMib: 0,
        ramReservedMib: 0,
        ramSleepingMib: 0,
        storage: { isLow: false },
        defaults: { memoryMib: 512, image: 'base' },
        egress: { isEnforced: true },
      },
    },
  });

  using laptop = startStubImpd({
    token: 'imps-token',
    answers: {
      'imps/list': [buildMockImp({ name: 'dev' })],
      'images/list': [{ name: 'base' }],
      'tokens/whoami': { kind: 'token', name: 'root', scope: 'manage', imps: null },
      'system/info': {
        version: '0.12.0',
        ramBudgetMib: 8192,
        ramUsedMib: 0,
        ramReservedMib: 0,
        ramSleepingMib: 0,
        storage: { isLow: false },
        defaults: { memoryMib: 512, image: 'base' },
        egress: { isEnforced: true },
      },
    },
  });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'imps-token' },
      laptop: { url: laptop.url, token: 'imps-token' },
    },
  });

  const placed = await runCli({ args: ['new', 'dev', '--place'], env: ctx.home });

  expect(placed).toStrictEqual({
    stdout: '',
    stderr: 'imp: dev exists on laptop already; pick another name\n',
    code: 1,
  });

  expect([...box.calls, ...laptop.calls].filter((call) => call.path === 'imps/create')).toBeEmpty();
});

test('#new passes over a host whose token is limited, then exposes, under --place --public', async () => {
  await using ctx = await setupTest();

  const created = buildMockImp({ name: 'dev' });

  // the most RAM, but its token reaches only some imps
  using big = startStubImpd({
    token: 'imps-token',
    answers: {
      'imps/list': [],
      'images/list': [{ name: 'base' }],
      'tokens/whoami': { kind: 'token', name: 'root', scope: 'manage', imps: ['dev*'] },
      'system/info': {
        version: '0.12.0',
        ramBudgetMib: 65_536,
        ramUsedMib: 0,
        ramReservedMib: 0,
        ramSleepingMib: 0,
        storage: { isLow: false },
        defaults: { memoryMib: 512, image: 'base' },
        egress: { isEnforced: true },
      },
    },
  });

  using small = startStubImpd({
    token: 'imps-token',
    answers: {
      'imps/list': [],
      'images/list': [{ name: 'base' }],
      'tokens/whoami': { kind: 'token', name: 'root', scope: 'manage', imps: null },
      'system/info': {
        version: '0.12.0',
        ramBudgetMib: 8192,
        ramUsedMib: 0,
        ramReservedMib: 0,
        ramSleepingMib: 0,
        storage: { isLow: false },
        defaults: { memoryMib: 512, image: 'base' },
        egress: { isEnforced: true },
      },
      'imps/create': created,
      'imps/expose': {
        url: 'https://dev.example.com',
        auth: 'token',
        user: null,
        credential: 'expose-credential',
      },
    },
  });

  writeHostConfig(ctx.home, {
    current: 'big',
    hosts: {
      big: { url: big.url, token: 'imps-token' },
      small: { url: small.url, token: 'imps-token' },
    },
  });

  const placed = await runCli({
    args: ['new', 'dev', '--place', '--public', '--json'],
    env: ctx.home,
  });

  const body: unknown = JSON.parse(placed.stdout);

  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(
    JSON.stringify({
      host: 'small',
      imp: created,
      public: {
        url: 'https://dev.example.com',
        auth: 'token',
        user: null,
        credential: 'expose-credential',
      },
    }),
  );

  expect(placed.stderr).toBe(
    [
      'imp: big: skipped: its token is limited to some imps, which --public and --net need it not to be',
      'imp: placing on small',
      '',
    ].join('\n'),
  );

  expect(body).toStrictEqual(sent);
  expect(placed.code).toBe(0);
  expect(big.calls.filter((call) => call.path === 'imps/create')).toBeEmpty();

  expect(small.calls.filter((call) => call.path === 'imps/expose')).toStrictEqual([
    {
      path: 'imps/expose',
      authorization: 'Bearer imps-token',
      input: { name: 'dev', auth: 'token' },
    },
  ]);
});

test('#new names the host of a failure after a placed create, and still writes the imp', async () => {
  await using ctx = await setupTest();

  const created = buildMockImp({ name: 'dev' });

  // expose fails, as on an impd without a public IP
  using box = startStubImpd({
    token: 'imps-token',
    answers: {
      'imps/list': [],
      'images/list': [{ name: 'base' }],
      'tokens/whoami': { kind: 'token', name: 'root', scope: 'manage', imps: null },
      'system/info': {
        version: '0.12.0',
        ramBudgetMib: 8192,
        ramUsedMib: 0,
        ramReservedMib: 0,
        ramSleepingMib: 0,
        storage: { isLow: false },
        defaults: { memoryMib: 512, image: 'base' },
        egress: { isEnforced: true },
      },
      'imps/create': created,
    },
    failures: {
      'imps/expose': {
        code: 'PRECONDITION_FAILED',
        status: 412,
        message: 'IMP_PUBLIC_IP is not set',
      },
    },
  });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: 'imps-token' } },
  });

  const placed = await runCli({
    args: ['new', 'dev', '--place', '--public', '--json'],
    env: ctx.home,
  });

  const body: unknown = JSON.parse(placed.stdout);

  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(
    JSON.stringify({
      host: 'box',
      imp: created,
      error: 'PRECONDITION_FAILED: IMP_PUBLIC_IP is not set',
    }),
  );

  expect(placed.stderr).toBe(
    'imp: placing on box\nimp: dev was created on box; PRECONDITION_FAILED: IMP_PUBLIC_IP is not set\n',
  );

  expect(body).toStrictEqual(sent);
  expect(placed.code).toBe(1);
});
