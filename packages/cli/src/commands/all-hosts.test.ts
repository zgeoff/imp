import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockImp } from '@imp/api/test-utils/build-mock-imp';
import { writeHostConfig } from '../host-store';
import { runCli } from '../test-utils/start-cli';
import { startStubImpd } from '../test-utils/start-stub-impd';

// `ls --all` and `new --place` reach every saved host. The CLI runs as a
// user runs it, against stand-in impds on loopback, each in the state the
// test names.

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'imp-all-hosts-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const owned = stack.move();

  // the CLI's home, where config.json keeps the saved hosts
  const env = { HOME: dir, XDG_CONFIG_HOME: dir };

  return { env, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it lists every saved host and exits 3 when one of them fails', async () => {
  await using ctx = await setupTest();

  // db is on its way to another host
  using box = startStubImpd({
    token: 'all-hosts-token',
    answers: {
      'imps/list': [
        buildMockImp({ name: 'web', state: 'running', move: 'receiving' }),
        buildMockImp({ name: 'db', state: 'running', move: 'sending' }),
      ],
    },
  });

  using laptop = startStubImpd({
    token: 'all-hosts-token',
    answers: { 'imps/list': [buildMockImp({ name: 'dev', state: 'sleeping' })] },
  });

  writeHostConfig(ctx.env, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'all-hosts-token' },
      laptop: { url: laptop.url, token: 'all-hosts-token' },
      gone: { url: 'http://127.0.0.1:1', token: 'all-hosts-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all'], env: ctx.env });

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

test('it gives up on a host that never answers after 5 s', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({
    token: 'all-hosts-token',
    answers: { 'imps/list': [buildMockImp({ name: 'web', state: 'running' })] },
  });

  // takes the connection and never answers, as a sleeping laptop's impd
  // does from behind a stalled tailnet path
  using silent = startStubImpd({ token: 'all-hosts-token', isSilent: true });

  writeHostConfig(ctx.env, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'all-hosts-token' },
      silent: { url: silent.url, token: 'all-hosts-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all'], env: ctx.env });

  expect(
    listed.stdout
      .trimEnd()
      .split('\n')
      .map((row) => row.split(/\s+/u).slice(0, 3)),
  ).toStrictEqual([
    ['HOST', 'NAME', 'STATE'],
    ['box', 'web', 'running'],
  ]);

  expect(listed.stderr).toBe('imp: silent: no answer in 5 s\n');
  expect(listed.code).toBe(3);
}, 15_000);

test('it never prints a saved token in ls --all', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({
    token: 'all-hosts-secret-token',
    answers: { 'imps/list': [buildMockImp({ name: 'web' })] },
  });

  writeHostConfig(ctx.env, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'all-hosts-secret-token' },
      gone: { url: 'http://127.0.0.1:1', token: 'all-hosts-secret-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all'], env: ctx.env });

  expect(`${listed.stdout}${listed.stderr}`).not.toInclude('all-hosts-secret-token');
});

test('it writes the imps and the errors of every host as JSON for ls --all --json', async () => {
  await using ctx = await setupTest();

  // db carries `host`, a field a newer impd's imp could carry and this
  // CLI's schema lacks, which must not replace the saved host's name
  const web = buildMockImp({ name: 'web' });
  const db = { ...buildMockImp({ name: 'db' }), host: 'peer' };
  const dev = buildMockImp({ name: 'dev' });

  using box = startStubImpd({
    token: 'all-hosts-token',
    answers: { 'imps/list': [web, db] },
  });

  using laptop = startStubImpd({
    token: 'all-hosts-token',
    answers: { 'imps/list': [dev] },
  });

  writeHostConfig(ctx.env, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'all-hosts-token' },
      laptop: { url: laptop.url, token: 'all-hosts-token' },
      gone: { url: 'http://127.0.0.1:1', token: 'all-hosts-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all', '--json'], env: ctx.env });

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

test('it writes an empty JSON list and exits 1 when no host answers ls --all --json', async () => {
  await using ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: 'gone',
    hosts: {
      gone: { url: 'http://127.0.0.1:1', token: 'all-hosts-token' },
      away: { url: 'http://127.0.0.1:2', token: 'all-hosts-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all', '--json'], env: ctx.env });

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

test('it asks every host for its builders under ls --all --builders', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({ token: 'all-hosts-token', answers: { 'imps/list': [] } });
  using laptop = startStubImpd({ token: 'all-hosts-token', answers: { 'imps/list': [] } });

  writeHostConfig(ctx.env, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'all-hosts-token' },
      laptop: { url: laptop.url, token: 'all-hosts-token' },
    },
  });

  await runCli({ args: ['ls', '--all', '--builders'], env: ctx.env });

  expect([...box.calls, ...laptop.calls]).toStrictEqual([
    { path: 'imps/list', authorization: 'Bearer all-hosts-token', input: { builders: true } },
    { path: 'imps/list', authorization: 'Bearer all-hosts-token', input: { builders: true } },
  ]);
});

test('it asks no host for its builders under plain ls --all', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({ token: 'all-hosts-token', answers: { 'imps/list': [] } });
  using laptop = startStubImpd({ token: 'all-hosts-token', answers: { 'imps/list': [] } });

  writeHostConfig(ctx.env, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'all-hosts-token' },
      laptop: { url: laptop.url, token: 'all-hosts-token' },
    },
  });

  await runCli({ args: ['ls', '--all'], env: ctx.env });

  expect([...box.calls, ...laptop.calls]).toStrictEqual([
    { path: 'imps/list', authorization: 'Bearer all-hosts-token', input: undefined },
    { path: 'imps/list', authorization: 'Bearer all-hosts-token', input: undefined },
  ]);
});

test('it refuses ls --all with --host', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({ token: 'all-hosts-token' });

  writeHostConfig(ctx.env, {
    current: 'box',
    hosts: { box: { url: box.url, token: 'all-hosts-token' } },
  });

  const listed = await runCli({ args: ['--host', 'box', 'ls', '--all'], env: ctx.env });

  expect(listed).toStrictEqual({
    stdout: '',
    stderr: 'imp: --all lists every saved host; drop --host\n',
    code: 2,
  });

  expect(box.calls).toStrictEqual([]);
});

test('it refuses new --place with --host', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({ token: 'all-hosts-token' });

  writeHostConfig(ctx.env, {
    current: 'box',
    hosts: { box: { url: box.url, token: 'all-hosts-token' } },
  });

  const placed = await runCli({ args: ['--host', 'box', 'new', 'dev', '--place'], env: ctx.env });

  expect(placed).toStrictEqual({
    stdout: '',
    stderr: 'imp: --place picks among the saved hosts; drop --host\n',
    code: 2,
  });

  expect(box.calls).toStrictEqual([]);
});

test('it lists the current host alone under plain ls', async () => {
  await using ctx = await setupTest();

  // a field this CLI's schema lacks passes through as impd sent it
  const db = { ...buildMockImp({ name: 'db' }), host: 'peer' };

  using box = startStubImpd({ token: 'all-hosts-token', answers: { 'imps/list': [db] } });
  using laptop = startStubImpd({ token: 'all-hosts-token' });

  writeHostConfig(ctx.env, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'all-hosts-token' },
      laptop: { url: laptop.url, token: 'all-hosts-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--json'], env: ctx.env });

  const body: unknown = JSON.parse(listed.stdout);

  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(JSON.stringify([db]));

  expect(body).toStrictEqual(sent);
  expect(listed.code).toBe(0);
  expect(laptop.calls).toStrictEqual([]);
});

test('it skips a host without the image and moves past a RAM refusal under new --place', async () => {
  await using ctx = await setupTest();

  const created = buildMockImp({ name: 'dev' });

  // the most RAM, but its governor refuses the create, as a full host's does
  using big = startStubImpd({
    token: 'all-hosts-token',
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
    token: 'all-hosts-token',
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
    token: 'all-hosts-token',
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

  writeHostConfig(ctx.env, {
    current: 'big',
    hosts: {
      big: { url: big.url, token: 'all-hosts-token' },
      small: { url: small.url, token: 'all-hosts-token' },
      bare: { url: bare.url, token: 'all-hosts-token' },
    },
  });

  const placed = await runCli({ args: ['new', 'dev', '--place', '--json'], env: ctx.env });

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
    { path: 'imps/create', authorization: 'Bearer all-hosts-token', input: { name: 'dev' } },
  ]);

  expect(bare.calls.filter((call) => call.path === 'imps/create')).toBeEmpty();
});

test('it refuses new --place for a name a saved host has already', async () => {
  await using ctx = await setupTest();

  using box = startStubImpd({
    token: 'all-hosts-token',
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
    token: 'all-hosts-token',
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

  writeHostConfig(ctx.env, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'all-hosts-token' },
      laptop: { url: laptop.url, token: 'all-hosts-token' },
    },
  });

  const placed = await runCli({ args: ['new', 'dev', '--place'], env: ctx.env });

  expect(placed).toStrictEqual({
    stdout: '',
    stderr: 'imp: dev exists on laptop already; pick another name\n',
    code: 1,
  });

  expect([...box.calls, ...laptop.calls].filter((call) => call.path === 'imps/create')).toBeEmpty();
});

test('it passes over a host whose token is limited, then exposes, under new --place --public', async () => {
  await using ctx = await setupTest();

  const created = buildMockImp({ name: 'dev' });

  // the most RAM, but its token reaches only some imps
  using big = startStubImpd({
    token: 'all-hosts-token',
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
    token: 'all-hosts-token',
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

  writeHostConfig(ctx.env, {
    current: 'big',
    hosts: {
      big: { url: big.url, token: 'all-hosts-token' },
      small: { url: small.url, token: 'all-hosts-token' },
    },
  });

  const placed = await runCli({
    args: ['new', 'dev', '--place', '--public', '--json'],
    env: ctx.env,
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
      authorization: 'Bearer all-hosts-token',
      input: { name: 'dev', auth: 'token' },
    },
  ]);
});

test('it names the host of a failure after a placed create, and still writes the imp', async () => {
  await using ctx = await setupTest();

  const created = buildMockImp({ name: 'dev' });

  // expose fails, as on an impd without a public IP
  using box = startStubImpd({
    token: 'all-hosts-token',
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

  writeHostConfig(ctx.env, {
    current: 'box',
    hosts: { box: { url: box.url, token: 'all-hosts-token' } },
  });

  const placed = await runCli({
    args: ['new', 'dev', '--place', '--public', '--json'],
    env: ctx.env,
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
