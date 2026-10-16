import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImage } from '@impz/daemon/src/db/images';
import { createImp, findImpByName, updateImpMove } from '@impz/daemon/src/db/imps';
import { buildImagePaths, buildImpPaths } from '@impz/daemon/src/storage/data-layout';
import { buildMockNewImage } from '@impz/daemon/src/test-utils/build-mock-new-image';
import { buildMockNewImp } from '@impz/daemon/src/test-utils/build-mock-new-imp';
import { startStubInnerAgent } from '@impz/daemon/src/test-utils/start-stub-inner-agent';
import { invariant } from '@impz/test-utils/invariant';
import { waitFor } from '@impz/test-utils/wait-for';
import { writeHostConfig } from '../host-store';
import { buildStubTimeouts } from '../test-utils/build-stub-timeouts';
import { parseJsonOutput } from '../test-utils/parse-json-output';
import { runCli } from '../test-utils/start-cli';
import { startImpdHost } from '../test-utils/start-impd-host';
import { startStubNewerImpd } from '../test-utils/start-stub-newer-impd';
import { startStubOlderImpd } from '../test-utils/start-stub-older-impd';
import { startStubSilentHost } from '../test-utils/start-stub-silent-host';
import { listAllImps, listForkWarnings, readConsoleSession } from './imps';

// The CLI's home, where config.json keeps the saved hosts, so none of this
// machine's reaches it; each impd host a test starts releases into `stack`
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-imps-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { home: { HOME: dir, XDG_CONFIG_HOME: dir }, stack };
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
    stderr: 'impz: not a size: 1.5g (try 512m, 2g, 1t, or MiB as a whole number)\n',
    code: 2,
  });
});

test('#new refuses an IMP_URL that is not an http URL', async () => {
  const result = await runCli({ args: ['new', 'box'], env: { IMP_URL: 'localhost:7070' } });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: IMP_URL is not an http(s) URL: localhost:7070\n',
    code: 2,
  });
});

test('#new refuses --auth without --public before any call to impd', async () => {
  // nothing listens there: a call would fail on the connection instead
  const result = await runCli({
    args: ['new', 'box', '--auth', 'basic'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --auth and --user need --public\n',
    code: 2,
  });
});

test('#new refuses --public for a token limited to some imps, and creates nothing', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  const limited = await box.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev*'],
  });

  const result = await runCli({
    args: ['new', 'dev', '--public'],
    env: { ...ctx.home, IMP_URL: box.url, IMP_TOKEN: limited.secret },
  });

  const dev = await findImpByName(box.db, 'dev');

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --public needs a token with manage scope on the host; this one is limited\n',
    code: 1,
  });

  expect(dev).toBeUndefined();
});

test('#new creates an imp left out of every backup for --no-backup', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  const result = await runCli({
    args: ['new', 'chat', '--image', 'base', '--no-backup', '--json'],
    env: { ...ctx.home, IMP_URL: box.url, IMP_TOKEN: box.rootToken },
  });

  const chat = await findImpByName(box.db, 'chat');

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ name: 'chat', backup: false });
  expect(chat?.isBackedUp).toBe(false);
});

test('#new refuses --no-backup on an impd from before the setting, and creates nothing', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  const older = startStubOlderImpd(ctx.stack, box.sendRequest, {
    withoutFeatures: ['backupOptOut'],
  });

  const result = await runCli({
    args: ['new', 'chat', '--image', 'base', '--no-backup'],
    env: { ...ctx.home, IMP_URL: older.url, IMP_TOKEN: box.rootToken },
  });

  const chat = await findImpByName(box.db, 'chat');

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'impz: this impd has no backup opt-out and would back the imp up anyway; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(chat).toBeUndefined();
});

test('#console refuses a detach key that is not ctrl-<key>', async () => {
  const result = await runCli({
    args: ['console', 'box', '--detach-key', 'esc'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: String.raw`impz: --detach-key takes ctrl-<key> (a-z but h, i, j and m; @, \, ], ^ or _) or none, got esc
`,
    code: 2,
  });
});

test('#console refuses an empty session name', async () => {
  const result = await runCli({
    args: ['console', 'box', '--session', ''],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: 'impz: a session needs a name\n', code: 2 });
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
    'impz: --require takes broker; not network\n',
  ],
  [
    ['exec', 'box', '--agent', '--require', 'broker', '--', 'true'],
    'impz: --require does not go with --agent: an exec in the agent gets no broker\n',
  ],
])('#exec refuses %p before any call to impd', async (args, stderr) => {
  const ctx = await setupTest();

  // nothing listens there: a call would fail on the connection instead
  const result = await runCli({
    args,
    env: { ...ctx.home, IMP_URL: 'http://127.0.0.1:1', IMP_TOKEN: 'imps-token' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr, code: 2 });
});

test('#exec runs nothing for --require on an impd older than 0.30.0, without execRequire', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const older = startStubOlderImpd(ctx.stack, box.sendRequest, {
    withoutFeatures: ['execRequire'],
  });

  const result = await runCli({
    args: ['exec', 'box', '--require', 'broker', '--', 'true'],
    env: { ...ctx.home, IMP_URL: older.url, IMP_TOKEN: box.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'impz: this impd is older than 0.30.0 and would run the command without checking --require; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(older.calls).toStrictEqual(['system/info']);
});

test('#console refuses --log without a session before any call to impd', async () => {
  const ctx = await setupTest();

  // nothing listens there: a call would fail on the connection instead
  const result = await runCli({
    args: ['console', 'dev', '--no-session', '--log'],
    env: { ...ctx.home, IMP_URL: 'http://127.0.0.1:1', IMP_TOKEN: 'imps-token' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: 'impz: --log needs a session\n', code: 2 });
});

test('#console makes no call past the feature check for --log on an impd from before session logs', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const older = startStubOlderImpd(ctx.stack, box.sendRequest, { withoutFeatures: ['sessionLog'] });

  const result = await runCli({
    args: ['console', 'dev', '--session', 'main', '--log'],
    env: { ...ctx.home, IMP_URL: older.url, IMP_TOKEN: box.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'impz: this impd has no session logs and would start the session without a log; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(older.calls).toStrictEqual(['system/info']);
});

test('#ls lists every saved host and exits 3 when one of them fails', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });
  const laptop = await startImpdHost(ctx.stack, { env: {} });

  const boxImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, boxImage.digest).rootfs, 'rootfs');

  await createImage(box.db, boxImage);

  await box.client.imps.create({ name: 'web' });
  await box.client.imps.create({ name: 'db' });

  // db is on its way to another host
  const db = await findImpByName(box.db, 'db');

  invariant(db);

  await updateImpMove(box.db, db.id, 'sending');

  const laptopImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(laptop.dataDir, laptopImage.digest).rootfs, 'rootfs');

  await createImage(laptop.db, laptopImage);

  await laptop.client.imps.create({ name: 'dev' });
  await laptop.client.imps.sleep({ name: 'dev' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      laptop: { url: laptop.url, token: laptop.rootToken },
      gone: { url: 'http://127.0.0.1:1', token: 'gone-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all'], env: ctx.home });

  const rows = listed.stdout.trimEnd().split('\n');

  expect(rows.map((row) => row.split(/\s+/u).slice(0, 3))).toStrictEqual([
    ['HOST', 'NAME', 'STATE'],
    ['box', 'db', 'running'],
    ['box', 'web', 'running'],
    ['laptop', 'dev', 'sleeping'],
  ]);

  expect(rows[1]).toEndWith('  sending');
  expect(listed.stderr).toMatch(/^impz: gone: [^\n]+\n$/u);
  expect(listed.code).toBe(3);
});

test('#listAllImps gives up on a host that never answers once its timer runs out', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'web' });

  // takes the connection and never answers, as a sleeping laptop's impd
  // does from behind a stalled tailnet path
  const silent = startStubSilentHost(ctx.stack);

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      silent: { url: silent.url, token: 'silent-token' },
    },
  });

  const timeouts = buildStubTimeouts();
  const print = mock<(line: string) => void>();
  const printError = mock<(line: string) => void>();

  const listing = listAllImps({
    env: ctx.home,
    isJson: false,
    hasBuilders: false,
    print,
    printError,
    startTimer: timeouts.startTimer,
  });

  // box answered, so only the silent host's timer still runs; the hosts go
  // in name order
  await waitFor(() => {
    expect(timeouts.timers.map((timer) => timer.state)).toStrictEqual(['cancelled', 'pending']);
  });

  timeouts.firePending();

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

  expect(timeouts.timers.map((timer) => timer.ms)).toStrictEqual([5000, 5000]);
  expect(silent.requests).toStrictEqual(['/rpc/imps/list']);
  expect(printError).toHaveBeenCalledExactlyOnceWith('impz: silent: no answer in 5 s');
  expect(code).toBe(3);
});

test('#ls never prints a saved token under --all', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'web' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      gone: { url: 'http://127.0.0.1:1', token: 'gone-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all'], env: ctx.home });

  const printed = `${listed.stdout}${listed.stderr}`;

  expect(printed).not.toInclude(box.rootToken);
  expect(printed).not.toInclude('gone-token');
});

test('#ls writes the imps and the errors of every host as JSON for --all --json', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });
  const laptop = await startImpdHost(ctx.stack, { env: {} });

  const boxImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, boxImage.digest).rootfs, 'rootfs');

  await createImage(box.db, boxImage);

  await box.client.imps.create({ name: 'web' });
  await box.client.imps.create({ name: 'db' });

  const laptopImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(laptop.dataDir, laptopImage.digest).rootfs, 'rootfs');

  await createImage(laptop.db, laptopImage);

  await laptop.client.imps.create({ name: 'dev' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      laptop: { url: laptop.url, token: laptop.rootToken },
      gone: { url: 'http://127.0.0.1:1', token: 'gone-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all', '--json'], env: ctx.home });

  const body: unknown = JSON.parse(listed.stdout);

  const boxImps = await box.client.imps.list();
  const laptopImps = await laptop.client.imps.list();

  // what the CLI received, dates as JSON writes them, with each imp's host
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(
    JSON.stringify([
      ...boxImps.map((imp) => Object.assign(imp, { host: 'box' })),
      ...laptopImps.map((imp) => Object.assign(imp, { host: 'laptop' })),
    ]),
  );

  expect(body).toStrictEqual({
    imps: sent,
    errors: [{ host: 'gone', message: expect.any(String) as unknown }],
  });

  expect(listed.code).toBe(3);
});

test('#ls writes an empty JSON list and exits 1 when no host answers --all --json', async () => {
  const ctx = await setupTest();

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
    expect.stringMatching(/^impz: away: /u) as unknown,
    expect.stringMatching(/^impz: gone: /u) as unknown,
  ]);

  expect(listed.code).toBe(1);
});

test('#ls lists every host’s builders under --all --builders', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });
  const laptop = await startImpdHost(ctx.stack, { env: {} });

  // a builder imp on each host, as a host build leaves one
  const boxImage = await createImage(box.db, buildMockNewImage({ name: 'base' }));

  await createImp(
    box.db,
    buildMockNewImp({ name: 'box-builder', imageId: boxImage.id, kind: 'builder' }),
  );

  const laptopImage = await createImage(laptop.db, buildMockNewImage({ name: 'base' }));

  await createImp(
    laptop.db,
    buildMockNewImp({ name: 'laptop-builder', imageId: laptopImage.id, kind: 'builder' }),
  );

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      laptop: { url: laptop.url, token: laptop.rootToken },
    },
  });

  const listed = await runCli({ args: ['ls', '--all', '--builders', '--json'], env: ctx.home });

  const body: unknown = JSON.parse(listed.stdout);

  const boxBuilder = await box.client.imps.get({ name: 'box-builder' });
  const laptopBuilder = await laptop.client.imps.get({ name: 'laptop-builder' });

  // what the CLI received, dates as JSON writes them, with each imp's host
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(
    JSON.stringify([
      { ...boxBuilder, host: 'box' },
      { ...laptopBuilder, host: 'laptop' },
    ]),
  );

  expect(body).toStrictEqual({ imps: sent, errors: [] });
});

test('#ls lists no builder under plain --all', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });
  const laptop = await startImpdHost(ctx.stack, { env: {} });

  // a builder imp on each host, as a host build leaves one
  const boxImage = await createImage(box.db, buildMockNewImage({ name: 'base' }));

  await createImp(
    box.db,
    buildMockNewImp({ name: 'box-builder', imageId: boxImage.id, kind: 'builder' }),
  );

  const laptopImage = await createImage(laptop.db, buildMockNewImage({ name: 'base' }));

  await createImp(
    laptop.db,
    buildMockNewImp({ name: 'laptop-builder', imageId: laptopImage.id, kind: 'builder' }),
  );

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      laptop: { url: laptop.url, token: laptop.rootToken },
    },
  });

  const listed = await runCli({ args: ['ls', '--all', '--json'], env: ctx.home });

  const body: unknown = JSON.parse(listed.stdout);

  expect(body).toStrictEqual({ imps: [], errors: [] });
});

test('#ls refuses --all with --host', async () => {
  const ctx = await setupTest();

  // nothing listens there: a call would fail on the connection instead
  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: 'http://127.0.0.1:1', token: 'imps-token' } },
  });

  const listed = await runCli({ args: ['--host', 'box', 'ls', '--all'], env: ctx.home });

  expect(listed).toStrictEqual({
    stdout: '',
    stderr: 'impz: --all lists every saved host; drop --host\n',
    code: 2,
  });
});

test('#new refuses --place with --host', async () => {
  const ctx = await setupTest();

  // nothing listens there: a call would fail on the connection instead
  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: 'http://127.0.0.1:1', token: 'imps-token' } },
  });

  const placed = await runCli({ args: ['--host', 'box', 'new', 'dev', '--place'], env: ctx.home });

  expect(placed).toStrictEqual({
    stdout: '',
    stderr: 'impz: --place picks among the saved hosts; drop --host\n',
    code: 2,
  });
});

test('#ls lists the current host alone without --all', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'db' });

  // nothing listens at laptop's URL: asking it would print its error
  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      laptop: { url: 'http://127.0.0.1:1', token: 'laptop-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--json'], env: ctx.home });
  const imps = await box.client.imps.list();

  // dates as JSON writes them
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(JSON.stringify(imps));

  expect({ ...listed, stdout: JSON.parse(listed.stdout) as unknown }).toStrictEqual({
    stdout: sent,
    stderr: '',
    code: 0,
  });
});

test('#ls prints --json output in the shape of the committed schema', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'db' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const listed = await runCli({ args: ['ls', '--json'], env: ctx.home });

  expect(listed.code).toBe(0);
  expect(parseJsonOutput('ls', listed.stdout).data).toStrictEqual(JSON.parse(listed.stdout));
});

test('#ls marks an awake imp whose inner container is down', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  const imp = await box.client.imps.create({ name: 'web' });

  // its agent answers, with the container down after three restarts
  await startStubInnerAgent(buildImpPaths(box.dataDir, imp.id).vsockSocket, {
    inner: { up: false, restarts: 3, lastError: 'start inner init: exit status 1' },
    stack: ctx.stack,
  });

  await box.runIdleCheck();

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const listed = await runCli({ args: ['ls'], env: ctx.home });

  const row = listed.stdout.split('\n').find((line) => line.startsWith('web '));

  expect(listed.code).toBe(0);
  expect(row).toInclude('container down');
});

test('#ls passes through as sent a host field that a newer impd adds to its imps', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'db' });

  // a release after this CLI's adds `host` to each imp
  const newer = startStubNewerImpd(ctx.stack, box.sendRequest, {
    withFields: { 'imps/list': { host: 'peer' } },
  });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: newer.url, token: box.rootToken } },
  });

  const listed = await runCli({ args: ['ls', '--json'], env: ctx.home });
  const imps = await box.client.imps.list();

  // dates as JSON writes them
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(
    JSON.stringify(imps.map((imp) => Object.assign(imp, { host: 'peer' }))),
  );

  expect({ ...listed, stdout: JSON.parse(listed.stdout) as unknown }).toStrictEqual({
    stdout: sent,
    stderr: '',
    code: 0,
  });
});

test('#ls names the saved host under --all over a host field that a newer impd adds', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'db' });

  // a release after this CLI's adds `host` to each imp
  const newer = startStubNewerImpd(ctx.stack, box.sendRequest, {
    withFields: { 'imps/list': { host: 'peer' } },
  });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: newer.url, token: box.rootToken } },
  });

  const listed = await runCli({ args: ['ls', '--all', '--json'], env: ctx.home });
  const imps = await box.client.imps.list();

  // dates as JSON writes them, each imp under its saved host's name
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(
    JSON.stringify(imps.map((imp) => Object.assign(imp, { host: 'box' }))),
  );

  expect({ ...listed, stdout: JSON.parse(listed.stdout) as unknown }).toStrictEqual({
    stdout: { imps: sent, errors: [] },
    stderr: '',
    code: 0,
  });
});

test('#new skips a host without the image and moves past a RAM refusal under --place', async () => {
  const ctx = await setupTest();
  const big = await startImpdHost(ctx.stack, { env: { IMP_KSM: '1' } });
  const small = await startImpdHost(ctx.stack, { env: {} });
  const bare = await startImpdHost(ctx.stack, { env: {} });

  // big: the most free RAM by system.info, but a held imp whose KSM saving
  // the governor keeps free leaves no room for a boot
  const bigImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(big.dataDir, bigImage.digest).rootfs, 'rootfs');

  await createImage(big.db, bigImage);

  await big.client.imps.create({ name: 'held' });
  await big.client.leases.acquire({ name: 'held', label: 'work', ttlSeconds: 3600 });

  big.ksm.profitMib = 16_000;

  // small: two awake imps, so less free RAM than big
  const smallImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(small.dataDir, smallImage.digest).rootfs, 'rootfs');

  await createImage(small.db, smallImage);

  await small.client.imps.create({ name: 'web' });
  await small.client.imps.create({ name: 'db' });

  // bare: the most free RAM of all, but not the image asked for
  const bareImage = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(bare.dataDir, bareImage.digest).rootfs, 'rootfs');

  await createImage(bare.db, bareImage);

  writeHostConfig(ctx.home, {
    current: 'big',
    hosts: {
      big: { url: big.url, token: big.rootToken },
      small: { url: small.url, token: small.rootToken },
      bare: { url: bare.url, token: bare.rootToken },
    },
  });

  const placed = await runCli({
    args: ['new', 'dev', '--image', 'base', '--place', '--json'],
    env: ctx.home,
  });

  const body: unknown = JSON.parse(placed.stdout);

  const created = await small.client.imps.get({ name: 'dev' });

  // dates as JSON writes them
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(JSON.stringify({ host: 'small', imp: created }));

  expect(placed.stderr).toBe(
    [
      'impz: bare: skipped: it has no image base',
      'impz: placing on big',
      'impz: big: not enough RAM: 17024 of 16384 MiB in use, 1024 MiB requested, and no idle imp left to sleep; trying the next host',
      'impz: placing on small',
      '',
    ].join('\n'),
  );

  expect(body).toStrictEqual(sent);
  expect(placed.code).toBe(0);

  const bigDev = await findImpByName(big.db, 'dev');

  expect(bigDev).toBeUndefined();

  const bareDev = await findImpByName(bare.db, 'dev');

  expect(bareDev).toBeUndefined();
});

test('#new places on a reachable host under --place when another saved host does not answer', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  // nothing listens at gone's address
  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      gone: { url: 'http://127.0.0.1:1', token: 'gone-token' },
    },
  });

  const placed = await runCli({
    args: ['new', 'dev', '--image', 'base', '--place', '--json'],
    env: ctx.home,
  });

  const created = await box.client.imps.get({ name: 'dev' });

  // dates as JSON writes them
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(JSON.stringify({ host: 'box', imp: created }));

  expect({ ...placed, stdout: JSON.parse(placed.stdout) as unknown }).toStrictEqual({
    stdout: sent,
    stderr: [
      'impz: gone: skipped: Unable to connect. Is the computer able to access the url?',
      'impz: placing on box',
      '',
    ].join('\n'),
    code: 0,
  });
});

test('#new refuses --place when no saved host can take the imp', async () => {
  const ctx = await setupTest();
  const bare = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  // bare has an image, but not the one asked for
  await Bun.write(buildImagePaths(bare.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(bare.db, image);

  writeHostConfig(ctx.home, {
    current: 'bare',
    hosts: { bare: { url: bare.url, token: bare.rootToken } },
  });

  const placed = await runCli({
    args: ['new', 'dev', '--image', 'base', '--place'],
    env: ctx.home,
  });

  const dev = await findImpByName(bare.db, 'dev');

  expect(placed).toStrictEqual({
    stdout: '',
    stderr: 'impz: bare: skipped: it has no image base\nimpz: no saved host can take the imp\n',
    code: 1,
  });

  expect(dev).toBeUndefined();
});

test('#new refuses --place for a name a saved host has already', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });
  const laptop = await startImpdHost(ctx.stack, { env: {} });

  const boxImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, boxImage.digest).rootfs, 'rootfs');

  await createImage(box.db, boxImage);

  await box.client.imps.create({ name: 'web' });

  const laptopImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(laptop.dataDir, laptopImage.digest).rootfs, 'rootfs');

  await createImage(laptop.db, laptopImage);

  await laptop.client.imps.create({ name: 'dev' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: box.rootToken },
      laptop: { url: laptop.url, token: laptop.rootToken },
    },
  });

  const placed = await runCli({ args: ['new', 'dev', '--place'], env: ctx.home });

  expect(placed).toStrictEqual({
    stdout: '',
    stderr: 'impz: dev exists on laptop already; pick another name\n',
    code: 1,
  });

  const boxDev = await findImpByName(box.db, 'dev');

  expect(boxDev).toBeUndefined();
});

test('#new passes over a host whose token is limited, then exposes, under --place --public', async () => {
  const ctx = await setupTest();
  const big = await startImpdHost(ctx.stack, { env: {} });

  // a domain and a public address, so imps.expose works
  const small = await startImpdHost(ctx.stack, {
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    },
  });

  const bigImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(big.dataDir, bigImage.digest).rootfs, 'rootfs');

  await createImage(big.db, bigImage);

  // big's saved token reaches only some imps
  const limited = await big.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev*'],
  });

  const smallImage = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(small.dataDir, smallImage.digest).rootfs, 'rootfs');

  await createImage(small.db, smallImage);

  writeHostConfig(ctx.home, {
    current: 'big',
    hosts: {
      big: { url: big.url, token: limited.secret },
      small: { url: small.url, token: small.rootToken },
    },
  });

  const placed = await runCli({
    args: ['new', 'dev', '--place', '--public', '--json'],
    env: ctx.home,
  });

  const body: unknown = JSON.parse(placed.stdout);

  // the create's answer, from before the expose
  const { public: _exposed, ...created } = await small.client.imps.get({ name: 'dev' });

  // dates as JSON writes them
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const imp: unknown = JSON.parse(JSON.stringify(created));

  expect(placed.stderr).toBe(
    [
      'impz: big: skipped: its token is limited to some imps, which --public and --net need it not to be',
      'impz: placing on small',
      '',
    ].join('\n'),
  );

  expect(body).toStrictEqual({
    host: 'small',
    imp,
    public: {
      url: 'https://dev.imp.example.com',
      auth: 'token',
      user: null,
      credential: expect.any(String) as unknown,
    },
  });

  expect(placed.code).toBe(0);

  const bigDev = await findImpByName(big.db, 'dev');

  expect(bigDev).toBeUndefined();
});

test('#new names the host of a failure after a placed create, and still writes the imp', async () => {
  const ctx = await setupTest();

  // box has no IMP_PUBLIC_IP, so its expose fails
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const placed = await runCli({
    args: ['new', 'dev', '--place', '--public', '--json'],
    env: ctx.home,
  });

  const body: unknown = JSON.parse(placed.stdout);

  const created = await box.client.imps.get({ name: 'dev' });

  // dates as JSON writes them
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the wire turns dates into strings, as JSON does
  const sent: unknown = JSON.parse(
    JSON.stringify({
      host: 'box',
      imp: created,
      error: 'PRECONDITION_FAILED: public imps need IMP_DOMAIN and IMP_PUBLIC_IP on the host',
    }),
  );

  expect(placed.stderr).toBe(
    'impz: placing on box\nimpz: dev was created on box; PRECONDITION_FAILED: public imps need IMP_DOMAIN and IMP_PUBLIC_IP on the host\n',
  );

  expect(body).toStrictEqual(sent);
  expect(placed.code).toBe(1);
});
