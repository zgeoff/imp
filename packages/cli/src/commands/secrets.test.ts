import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../test-utils/start-cli';
import { startStubImpd } from '../test-utils/start-stub-impd';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-secrets-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const owned = stack.move();

  // the CLI's home, so no saved host of this machine reaches it
  const home = { HOME: dir, XDG_CONFIG_HOME: dir };

  return { home, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it refuses a secret value given as a flag, which only stdin may carry', async () => {
  const result = await runCli({
    args: ['secret', 'add', 'gh', '--kind', 'github', '--value', 'ghp_x'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: unknown flag --value for add (see --help)\n',
    code: 2,
  });
});

test.each([
  [
    'an unknown kind',
    ['--kind', 'gitlab'],
    'imp: --kind must be one of github, anthropic, npm, custom, oauth',
  ],
  ['a custom kind without hosts', ['--kind', 'custom'], 'imp: --kind custom needs --hosts'],
  [
    'hosts on a github kind',
    ['--kind', 'github', '--hosts', 'api.github.com'],
    'imp: --hosts, --header, --scheme and --user are for --kind custom and --kind oauth',
  ],
  ['an oauth kind without hosts', ['--kind', 'oauth'], 'imp: --kind oauth needs --hosts'],
  [
    'an oauth kind without a token URL and client ID',
    ['--kind', 'oauth', '--hosts', 'api.example.com'],
    'imp: --kind oauth needs --token-url and --client-id',
  ],
  [
    'an http token URL',
    [
      '--kind',
      'oauth',
      '--hosts',
      'api.example.com',
      '--token-url',
      'http://a.example.com/t',
      '--client-id',
      'c',
    ],
    'imp: Invalid URL',
  ],
  [
    'an unknown token format',
    [
      '--kind',
      'oauth',
      '--hosts',
      'api.example.com',
      '--token-url',
      'https://a.example.com/t',
      '--client-id',
      'c',
      '--token-format',
      'xml',
    ],
    'imp: Invalid option: expected one of "json"|"form"',
  ],
  [
    'oauth flags on a custom kind',
    ['--kind', 'custom', '--hosts', 'api.example.com', '--client-id', 'c'],
    'imp: --token-url, --client-id and --token-format are for --kind oauth',
  ],
  [
    'an address as a host',
    ['--kind', 'custom', '--hosts', '10.0.0.1'],
    'imp: must be a lowercase hostname such as api.example.com',
  ],
  [
    'an unknown scheme',
    ['--kind', 'custom', '--hosts', 'api.example.com', '--scheme', 'digest'],
    'imp: Invalid option: expected one of "bearer"|"basic"|"raw"',
  ],
])('it refuses %s before it asks for a value', async (_case, flags, message) => {
  const result = await runCli({
    args: ['secret', 'add', 'api', ...flags],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: `${message}\n`, code: 2 });
});

test('it refuses an audit limit outside 1 to 1000', async () => {
  const result = await runCli({
    args: ['audit', '--limit', '0'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: --limit must be a whole number from 1 to 1000\n',
    code: 2,
  });
});

test.each([
  [['secret', 'add', 'gh', '--kind', 'github', '--rebind'], 'imp: --rebind needs --replace\n'],
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

  using impd = startStubImpd({ token: 'secrets-token' });

  const result = await runCli({
    args,
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'secrets-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result).toStrictEqual({ stdout: '', stderr, code: 2 });
  expect(impd.calls).toStrictEqual([]);
});

// an impd from before 0.27.0, with none of the newer features
test.each([
  [
    ['secret', 'add', 'gh', '--kind', 'github', '--replace'],
    'is older than 0.27.0 and would let --replace change the hosts and keep every grant',
  ],
  [
    ['secret', 'add', 'gh', '--kind', 'github', '--replace', '--rebind'],
    'is older than 0.27.0 and would let --replace change the hosts and keep every grant',
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

  using impd = startStubImpd({
    token: 'secrets-token',
    answers: {
      'system/info': { version: '0.26.0', features: { sessionOffsets: true, leases: true } },
    },
  });

  const result = await runCli({
    args,
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'secrets-token' },
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
])('it replaces no secret when the feature check finds %s', async (_case, info) => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'secrets-token',
    answers: { 'system/info': info },
  });

  const result = await runCli({
    args: ['secret', 'add', 'gh', '--kind', 'github', '--replace'],
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'secrets-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result.code).toBe(1);
  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info']);
});

test('it replaces a secret on an impd with the feature', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'secrets-token',
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
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'secrets-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result.code).toBe(0);
  expect(impd.calls.map((call) => call.path)).toStrictEqual(['system/info', 'secrets/add']);
});

test('it adds a plain secret without a feature check', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'secrets-token',
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
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'secrets-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result.code).toBe(0);
  expect(impd.calls.map((call) => call.path)).toStrictEqual(['secrets/add']);
});

test('it says until when an added oauth secret’s access token is valid', async () => {
  await using ctx = await setupTest();

  using impd = startStubImpd({
    token: 'secrets-token',
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
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'secrets-token' },
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

  using impd = startStubImpd({
    token: 'secrets-token',
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
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'secrets-token' },
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

  using impd = startStubImpd({
    token: 'secrets-token',
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
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'secrets-token' },
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

  using impd = startStubImpd({
    token: 'secrets-token',
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
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'secrets-token' },
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

  using impd = startStubImpd({
    token: 'secrets-token',
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
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'secrets-token' },
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

  using impd = startStubImpd({
    token: 'secrets-token',
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
    env: { ...ctx.home, IMP_URL: impd.url, IMP_TOKEN: 'secrets-token' },
    stdin: 'fake-token\n',
  });

  expect(result.code).toBe(0);

  expect(impd.calls[1]).toStrictEqual({
    path: 'secrets/add',
    authorization: 'Bearer secrets-token',
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
