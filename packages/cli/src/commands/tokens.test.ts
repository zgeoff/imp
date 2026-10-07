import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../test-utils/start-cli';
import { startStubImpd } from '../test-utils/start-stub-impd';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-tokens-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const owned = stack.move();

  // the CLI's home, so no saved host of this machine reaches it
  const home = { HOME: dir, XDG_CONFIG_HOME: dir };

  return { home, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it refuses a scope a token cannot have', async () => {
  const result = await runCli({
    args: ['token', 'new', 'ci', '--scope', 'root'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: --scope must be one of read, exec, manage\n',
    code: 2,
  });
});

test('it refuses an imp pattern that is not an imp name', async () => {
  const result = await runCli({
    args: ['token', 'new', 'ci', '--scope', 'exec', '--imps', 'Dev*'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'imp: --imps takes imp names with * for any run of characters, such as dev-*; not Dev*\n',
    code: 2,
  });
});

test('it refuses a private key where a .pub file belongs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-key-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const privateKey = join(dir, 'id_ed25519');

  await writeFile(privateKey, '-----BEGIN OPENSSH PRIVATE KEY-----\n');

  const result = await runCli({
    args: ['token', 'key', 'add', 'ci', privateKey],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: `imp: ${privateKey} is a private key; give its .pub file\n`,
    code: 2,
  });
});

test('it refuses a .pub file that holds no key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-key-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const empty = join(dir, 'empty.pub');

  await writeFile(empty, '# nothing\n');

  const result = await runCli({
    args: ['token', 'key', 'add', 'ci', empty],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: `imp: ${empty} holds no key\n`, code: 2 });
});

test('it refuses an --ssh-key file that is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-key-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const missing = join(dir, 'missing.pub');

  const result = await runCli({
    args: ['token', 'new', 'ci', '--scope', 'exec', '--ssh-key', missing],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: `imp: cannot read ${missing}: ENOENT: no such file or directory, open '${missing}'\n`,
    code: 2,
  });
});

test.each([
  [
    ['token', 'new', 'agent', '--scope', 'manage', '--grantable', 'gh'],
    'imp: --grantable needs --scope manage and --imps\n',
  ],
  [
    ['token', 'new', 'agent', '--scope', 'exec', '--imps', 'agent-*', '--grantable', 'gh'],
    'imp: --grantable needs --scope manage and --imps\n',
  ],
  [
    [
      'token',
      'new',
      'agent',
      '--scope',
      'manage',
      '--imps',
      'agent-*',
      '--grantable',
      'Not A Name',
    ],
    'imp: --grantable takes secret names, such as gh,npm; not Not A Name\n',
  ],
  [
    ['token', 'new', 'agent', '--scope', 'manage', '--imps', '', '--grantable', 'gh'],
    'imp: --imps takes imp names with * for any run of characters, such as dev-*; not \n',
  ],
  [
    ['token', 'new', 'agent', '--scope', 'manage', '--imps', ' , ', '--grantable', 'gh'],
    'imp: --imps takes imp names with * for any run of characters, such as dev-*; not  , \n',
  ],
  [
    ['token', 'set', 'agent', '--grantable', 'Not A Name'],
    'imp: --grantable takes secret names, such as gh,npm; not Not A Name\n',
  ],
])('it refuses %p before any call to impd', async (args, stderr) => {
  await using ctx = await setupTest();

  using impd = startStubImpd({ token: 'tokens-token' });

  const result = await runCli({
    args,
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'tokens-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result).toStrictEqual({ stdout: '', stderr, code: 2 });
  expect(impd.calls).toStrictEqual([]);
});

// an impd from before 0.27.0, with none of the newer features
test.each([
  [
    ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    'is older than 0.27.0 and would drop --grantable and make the token without that limit',
  ],
  [
    ['token', 'set', 'agent', '--grantable', 'gh'],
    'is older than 0.34.0 and would not know tokens.update',
  ],
])('it makes no call past the feature check for %p on an older impd', async (args, reason) => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'tokens-token',
    answers: {
      'system/info': { version: '0.26.0', features: { sessionOffsets: true, leases: true } },
    },
  });

  const result = await runCli({
    args,
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'tokens-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: `imp: this impd ${reason}; nothing was changed. Upgrade impd, or use an older imp CLI\n`,
    code: 1,
  });

  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info']);
});

test.each([
  [
    'false flags',
    {
      version: '0.27.0',
      features: { sessionOffsets: true, leases: true, grantableTokens: false, secretRebind: false },
    },
  ],
  ['no features object', { version: '0.14.0' }],
])('it creates no token when the feature check finds %s', async (_case, info) => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'tokens-token',
    answers: { 'system/info': info },
  });

  const result = await runCli({
    args: ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'tokens-token' },
  });

  expect(result.code).toBe(1);
  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info']);
});

test('it creates no token when the feature check fails', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'tokens-token',
    failures: {
      'system/info': { code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'boom' },
    },
  });

  const result = await runCli({
    args: ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'tokens-token' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: INTERNAL_SERVER_ERROR: boom\n',
    code: 1,
  });

  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info']);
});

test('it creates a grantable token on an impd with the feature', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'tokens-token',
    answers: {
      'system/info': { version: '0.27.0', features: { grantableTokens: true } },
      'tokens/create': {
        token: {
          name: 'agent',
          scope: 'manage',
          imps: ['agent-*'],
          sshKeys: [],
          grantable: ['gh'],
          createdAt: new Date('2026-10-03T00:00:00.000Z'),
        },
        secret: 'imp_made.token-secret',
      },
    },
  });

  const result = await runCli({
    args: ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'tokens-token' },
  });

  expect(result).toStrictEqual({
    stdout: 'imp_made.token-secret\n',
    stderr: 'imp: token agent made; impd shows its secret only this once\n',
    code: 0,
  });

  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info', 'tokens/create']);
});

test('it sends the grantable list on token set to an impd with tokens.update', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'tokens-token',
    answers: {
      'system/info': { version: '0.34.0', features: { tokenUpdate: true } },
      'tokens/update': {
        name: 'agent',
        scope: 'manage',
        imps: ['agent-*'],
        sshKeys: [],
        grantable: ['gh'],
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
      },
    },
  });

  const result = await runCli({
    args: ['token', 'set', 'agent', '--grantable', 'gh', '--json'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'tokens-token' },
  });

  expect(result).toStrictEqual({
    stdout: `${JSON.stringify(
      {
        name: 'agent',
        scope: 'manage',
        imps: ['agent-*'],
        sshKeys: [],
        grantable: ['gh'],
        createdAt: '2026-10-03T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    stderr: '',
    code: 0,
  });

  expect(impd.calls).toStrictEqual([
    { path: 'system/info', authorization: 'Bearer tokens-token', input: undefined },
    {
      path: 'tokens/update',
      authorization: 'Bearer tokens-token',
      input: { name: 'agent', grantable: ['gh'] },
    },
  ]);
});

test('it clears the grantable list on token set with an empty --grantable', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'tokens-token',
    answers: {
      'system/info': { version: '0.34.0', features: { tokenUpdate: true } },
      'tokens/update': {
        name: 'agent',
        scope: 'manage',
        imps: ['agent-*'],
        sshKeys: [],
        grantable: [],
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
      },
    },
  });

  const result = await runCli({
    args: ['token', 'set', 'agent', '--grantable', '', '--json'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'tokens-token' },
  });

  expect(result.code).toBe(0);
  expect(impd.calls[1]?.input).toStrictEqual({ name: 'agent', grantable: [] });
});
