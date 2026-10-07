import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../test-utils/start-cli';
import { startStubRpcImpd } from '../test-utils/start-stub-rpc-impd';

// Some flags rely on fields an older impd drops unread, and `db copy` on a
// call it lacks, so the CLI checks impd's features before it writes or runs
// anything. The stand-in plays impds of each version, as no real one can.

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'imp-feature-gates-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const owned = stack.move();

  // the CLI's home, so no saved host of this machine reaches it
  const home = { HOME: dir, XDG_CONFIG_HOME: dir };

  return { home, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

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
  [['secret', 'add', 'gh', '--kind', 'github', '--rebind'], 'imp: --rebind needs --replace\n'],
  [
    ['exec', 'box', '--require', 'network', '--', 'true'],
    'imp: --require takes broker; not network\n',
  ],
  [
    ['exec', 'box', '--agent', '--require', 'broker', '--', 'true'],
    'imp: --require does not go with --agent: an exec in the agent gets no broker\n',
  ],
  [['console', 'dev', '--no-session', '--log'], 'imp: --log needs a session\n'],
  [
    [
      'secret',
      'add',
      'op-connect',
      '--kind',
      'custom',
      '--hosts',
      'a.example.com,b.example.com',
      '--upstream',
      'http://172.17.0.1:18081',
    ],
    'imp: --upstream needs exactly one host in --hosts\n',
  ],
  [
    ['secret', 'add', 'gh', '--kind', 'github', '--upstream', 'http://172.17.0.1:18081'],
    'imp: --upstream is for --kind custom\n',
  ],
  [
    [
      'secret',
      'add',
      'op-connect',
      '--kind',
      'custom',
      '--hosts',
      'op-connect.imp.internal',
      '--upstream',
      'http://172.17.0.1:18081/x',
    ],
    'imp: must be an origin with no path\n',
  ],
])('it refuses %p before any call to impd', async (args, stderr) => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({ token: 'feature-gates-token' });

  const result = await runCli({
    args,
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
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
    ['secret', 'add', 'gh', '--kind', 'github', '--replace'],
    'is older than 0.27.0 and would let --replace change the hosts and keep every grant',
  ],
  [
    ['secret', 'add', 'gh', '--kind', 'github', '--replace', '--rebind'],
    'is older than 0.27.0 and would let --replace change the hosts and keep every grant',
  ],
  [['db', 'copy', 'before-upgrade', '--json'], 'is older than 0.30.0 and would not know the call'],
  [
    ['console', 'dev', '--session', 'main', '--log'],
    'has no session logs and would start the session without a log',
  ],
  [
    ['token', 'set', 'agent', '--grantable', 'gh'],
    'is older than 0.34.0 and would not know tokens.update',
  ],
  [
    [
      'secret',
      'add',
      'codex',
      '--kind',
      'oauth',
      '--hosts',
      'chatgpt.com',
      '--token-url',
      'https://auth.example.com/oauth/token',
      '--client-id',
      'fake-client',
      '--token-format',
      'json',
    ],
    'has no oauth secrets and would refuse the oauth kind',
  ],
  [['secret', 'refresh', 'codex'], 'has no oauth secrets and would not know the command'],
  [
    [
      'secret',
      'add',
      'op-connect',
      '--kind',
      'custom',
      '--hosts',
      'op-connect.imp.internal',
      '--upstream',
      'http://172.17.0.1:18081',
    ],
    'has no secret upstreams and would send the credential to the host itself',
  ],
])('it makes no call past the feature check for %p on an older impd', async (args, reason) => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
    answers: {
      'system/info': { version: '0.26.0', features: { sessionOffsets: true, leases: true } },
    },
  });

  const result = await runCli({
    args,
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: `imp: this impd ${reason}; nothing was changed. Upgrade impd, or use an older imp CLI\n`,
    code: 1,
  });

  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info']);
});

test('it runs nothing for exec --require on an impd older than 0.30.0', async () => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
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
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'imp: this impd is older than 0.30.0 and would run the command without checking --require; nothing was changed. Upgrade impd, or use an older imp CLI\n',
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

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
    answers: { 'system/info': info },
  });

  const result = await runCli({
    args: ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
  });

  expect(result.code).toBe(1);
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
])('it replaces no secret when the feature check finds %s', async (_case, info) => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
    answers: { 'system/info': info },
  });

  const result = await runCli({
    args: ['secret', 'add', 'gh', '--kind', 'github', '--replace'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result.code).toBe(1);
  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info']);
});

test('it creates no token when the feature check fails', async () => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
    failures: {
      'system/info': { code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'boom' },
    },
  });

  const result = await runCli({
    args: ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
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

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
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
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
  });

  expect(result).toStrictEqual({
    stdout: 'imp_made.token-secret\n',
    stderr: 'imp: token agent made; impd shows its secret only this once\n',
    code: 0,
  });

  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info', 'tokens/create']);
});

test('it replaces a secret on an impd with the feature', async () => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
    answers: {
      'system/info': { version: '0.27.0', features: { secretRebind: true } },
      'secrets/add': {
        name: 'gh',
        kind: 'github',
        rules: [],
        imps: [],
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
        droppedGrants: 0,
      },
    },
  });

  const result = await runCli({
    args: ['secret', 'add', 'gh', '--kind', 'github', '--replace'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result.code).toBe(0);
  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info', 'secrets/add']);
});

test('it adds a plain secret without a feature check', async () => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
    answers: {
      'secrets/add': {
        name: 'gh',
        kind: 'github',
        rules: [],
        imps: [],
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
        droppedGrants: 0,
      },
    },
  });

  const result = await runCli({
    args: ['secret', 'add', 'gh', '--kind', 'github'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result.code).toBe(0);
  expect(impd.calls.map((call) => call.path)).toStrictEqual(['secrets/add']);
});

test('it prints the database copy’s fields in the order a restore script reads them', async () => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
    answers: {
      'system/info': { version: '0.30.0', features: { databaseCopy: true } },
      'system/copyDatabase': {
        path: '/var/lib/imp/db-copies/before-upgrade.sqlite',
        sizeBytes: 4096,
        lastMigration: '030_x',
        impVersion: '0.30.0',
        createdAt: new Date('2026-10-04T00:00:00.000Z'),
        integrity: 'ok',
      },
    },
  });

  const result = await runCli({
    args: ['db', 'copy', 'before-upgrade', '--json'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
  });

  expect(result).toStrictEqual({
    stdout: `${JSON.stringify(
      {
        path: '/var/lib/imp/db-copies/before-upgrade.sqlite',
        sizeBytes: 4096,
        lastMigration: '030_x',
        impVersion: '0.30.0',
        createdAt: '2026-10-04T00:00:00.000Z',
        integrity: 'ok',
      },
      null,
      2,
    )}\n`,
    stderr: '',
    code: 0,
  });

  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info', 'system/copyDatabase']);
});

test('it sends the grantable list on token set to an impd with tokens.update', async () => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
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
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
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
    { path: 'system/info', authorization: 'Bearer feature-gates-token', input: undefined },
    {
      path: 'tokens/update',
      authorization: 'Bearer feature-gates-token',
      input: { name: 'agent', grantable: ['gh'] },
    },
  ]);
});

test('it clears the grantable list on token set with an empty --grantable', async () => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
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
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
  });

  expect(result.code).toBe(0);
  expect(impd.calls[1]?.input).toStrictEqual({ name: 'agent', grantable: [] });
});

test('it says until when an added oauth secret’s access token is valid', async () => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
    answers: {
      'system/info': { version: '0.36.0', features: { oauthSecrets: true } },
      'secrets/add': {
        name: 'codex',
        kind: 'oauth',
        rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
        imps: [],
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
        droppedGrants: 0,
        oauth: {
          tokenUrl: 'https://auth.example.com/oauth/token',
          clientId: 'fake-client',
          tokenFormat: 'json',
          status: 'ready',
          expiresAt: new Date('2030-01-01T00:00:00.000Z'),
          refreshedAt: null,
          error: null,
          idClaims: null,
        },
      },
    },
  });

  const result = await runCli({
    args: [
      'secret',
      'add',
      'codex',
      '--kind',
      'oauth',
      '--hosts',
      'chatgpt.com',
      '--token-url',
      'https://auth.example.com/oauth/token',
      '--client-id',
      'fake-client',
      '--token-format',
      'json',
    ],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
    stdin: 'fake-refresh\n',
  });

  expect(result).toStrictEqual({
    stdout: [
      'NAME   KIND   STATE                                 HOSTS        IMPS',
      'codex  oauth  ready until 2030-01-01T00:00:00.000Z  chatgpt.com  -',
      '',
    ].join('\n'),
    stderr: 'imp: codex signed in, access token valid until 2030-01-01T00:00:00.000Z\n',
    code: 0,
  });

  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info', 'secrets/add']);
});

test('it says why an added oauth secret failed its sign-in', async () => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
    answers: {
      'system/info': { version: '0.36.0', features: { oauthSecrets: true } },
      'secrets/add': {
        name: 'codex',
        kind: 'oauth',
        rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
        imps: [],
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
        droppedGrants: 0,
        oauth: {
          tokenUrl: 'https://auth.example.com/oauth/token',
          clientId: 'fake-client',
          tokenFormat: 'json',
          status: 'needs_login',
          expiresAt: null,
          refreshedAt: null,
          error: 'invalid_grant',
          idClaims: null,
        },
      },
    },
  });

  const result = await runCli({
    args: [
      'secret',
      'add',
      'codex',
      '--kind',
      'oauth',
      '--hosts',
      'chatgpt.com',
      '--token-url',
      'https://auth.example.com/oauth/token',
      '--client-id',
      'fake-client',
      '--token-format',
      'json',
    ],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
    stdin: 'fake-refresh\n',
  });

  expect(result).toStrictEqual({
    stdout: [
      'NAME   KIND   STATE                        HOSTS        IMPS',
      'codex  oauth  needs_login (invalid_grant)  chatgpt.com  -',
      '',
    ].join('\n'),
    stderr: 'imp: codex is needs_login: invalid_grant\n',
    code: 0,
  });
});

test('it prints a refreshed oauth secret that is ready', async () => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
    answers: {
      'system/info': { version: '0.36.0', features: { oauthSecrets: true } },
      'secrets/refresh': {
        name: 'codex',
        kind: 'oauth',
        rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
        imps: [],
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
        oauth: {
          tokenUrl: 'https://auth.example.com/oauth/token',
          clientId: 'fake-client',
          tokenFormat: 'json',
          status: 'ready',
          expiresAt: new Date('2030-01-01T00:00:00.000Z'),
          refreshedAt: null,
          error: null,
          idClaims: null,
        },
      },
    },
  });

  const result = await runCli({
    args: ['secret', 'refresh', 'codex'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
  });

  expect(result).toStrictEqual({
    stdout: [
      'NAME   KIND   STATE                                 HOSTS        IMPS',
      'codex  oauth  ready until 2030-01-01T00:00:00.000Z  chatgpt.com  -',
      '',
    ].join('\n'),
    stderr: '',
    code: 0,
  });
});

test('it exits 1 for a refreshed oauth secret that is not ready', async () => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
    answers: {
      'system/info': { version: '0.36.0', features: { oauthSecrets: true } },
      'secrets/refresh': {
        name: 'codex',
        kind: 'oauth',
        rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
        imps: [],
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
        oauth: {
          tokenUrl: 'https://auth.example.com/oauth/token',
          clientId: 'fake-client',
          tokenFormat: 'json',
          status: 'pending',
          expiresAt: null,
          refreshedAt: null,
          error: 'HTTP 503',
          idClaims: null,
        },
      },
    },
  });

  const result = await runCli({
    args: ['secret', 'refresh', 'codex', '--json'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
  });

  const printed: unknown = JSON.parse(result.stdout);

  expect(printed).toStrictEqual({
    name: 'codex',
    kind: 'oauth',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    imps: [],
    createdAt: '2026-10-03T00:00:00.000Z',
    oauth: {
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'json',
      status: 'pending',
      expiresAt: null,
      refreshedAt: null,
      error: 'HTTP 503',
      idClaims: null,
    },
  });

  expect(result.stderr).toBe('imp: codex is pending: HTTP 503\n');
  expect(result.code).toBe(1);
});

test('it shows a state column on secret ls, with a dash for other kinds', async () => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
    answers: {
      'secrets/list': [
        {
          name: 'gh',
          kind: 'github',
          rules: [],
          imps: [],
          createdAt: new Date('2026-10-03T00:00:00.000Z'),
        },
        {
          name: 'codex',
          kind: 'oauth',
          rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
          imps: [],
          createdAt: new Date('2026-10-03T00:00:00.000Z'),
          oauth: {
            tokenUrl: 'https://auth.example.com/oauth/token',
            clientId: 'fake-client',
            tokenFormat: 'json',
            status: 'needs_login',
            expiresAt: null,
            refreshedAt: null,
            error: 'refresh_token_reused',
            idClaims: null,
          },
        },
      ],
    },
  });

  const result = await runCli({
    args: ['secret', 'ls'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
  });

  expect(result).toStrictEqual({
    stdout: [
      'NAME   KIND    STATE                               HOSTS        IMPS',
      'gh     github  -                                                -',
      'codex  oauth   needs_login (refresh_token_reused)  chatgpt.com  -',
      '',
    ].join('\n'),
    stderr: '',
    code: 0,
  });
});

test('it sends a secret upstream in the rule to an impd that knows it', async () => {
  await using ctx = await setupTest();

  using impd = startStubRpcImpd({
    token: 'feature-gates-token',
    answers: {
      'system/info': { version: '0.36.0', features: { secretUpstream: true } },
      'secrets/add': {
        name: 'op-connect',
        kind: 'custom',
        rules: [],
        imps: [],
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
        droppedGrants: 0,
      },
    },
  });

  const result = await runCli({
    args: [
      'secret',
      'add',
      'op-connect',
      '--kind',
      'custom',
      '--hosts',
      'op-connect.imp.internal',
      '--upstream',
      'http://172.17.0.1:18081',
    ],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'feature-gates-token' },
    stdin: 'fake-token\n',
  });

  expect(result.code).toBe(0);

  expect(impd.calls[1]).toStrictEqual({
    path: 'secrets/add',
    authorization: 'Bearer feature-gates-token',
    input: {
      name: 'op-connect',
      kind: 'custom',
      value: 'fake-token',
      rules: [
        {
          host: 'op-connect.imp.internal',
          header: 'authorization',
          scheme: 'bearer',
          upstream: 'http://172.17.0.1:18081',
        },
      ],
    },
  });
});
