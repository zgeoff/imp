import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { invariant } from '@imp/test-utils/invariant';
import { server } from '@imp/test-utils/mock-server';
import { createImpClient } from '@zgeoff/imp-client';
import { HttpResponse, http } from 'msw';
import { runCli } from '../test-utils/start-cli';
import { startStubInfoFaultImpd } from '../test-utils/start-stub-info-fault-impd';
import { startStubOlderImpd } from '../test-utils/start-stub-older-impd';

// impd's real app, listening on a loopback port for the spawned CLI, and an
// in-process client of it
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'cli-secrets-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
  });

  // the system drive impd boots with
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const impd = await createImpd(config, {
    db,

    // the bearer the CLI sends
    rootToken: 'root-token',
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },

    // the host's free space, so boot never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},

    // Firecracker and the CPU, which the test host may not have
    readIdentity: (files, ipv6Prefix) => ({
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: 'test',
      guestKernel: files.info.guestKernel.sha256,
      systemDrive: files.info.systemDrive.sha256,
      systemDrivePath: files.systemDrivePath,
      cpuModel: 'Test CPU',
      cpuFlags: 'test-flags',
      ipv6Prefix,
    }),

    // no IPv6 routes, tailnet, cgroups, taps or VMs on the test host
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: () =>
      Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] }),
    cgroups: buildStubCpuCgroups().cgroups,
    vms: vmm.startGeneration(),
    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },

    // no broker bundle, tunnel or OAuth timer without a guest network
    broker: {
      installBundle: () => Promise.resolve(),
      resolveTunnelTarget: () => Promise.reject(new Error('no network in tests')),
      runOAuthTimer: false,
    },

    // nft, conntrack and the uplinks belong to the host, not the test
    egress: {
      runNft: () => Promise.resolve(),
      flushConnections: () => Promise.resolve(),
      flushPair: () => Promise.resolve(),
      readForwardRules: () => Promise.resolve(''),
      forward: () => Promise.reject(new Error('no upstream in tests')),
      resolveExact: () => Promise.resolve([]),
      readConnected4: () => Promise.resolve(['172.17.0.0/16']),
      readConnected6: () => Promise.resolve([]),
      readUplinks: () => Promise.resolve({ ipv4: ['eth0'], ipv6: [] }),
    },

    // the VMs' memory as /proc would show it
    imps: {
      readRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
      readRssMib: (pid) => (vmm.alive.has(pid) ? 340 : null),
      growFilesystem: () => Promise.resolve(false),
      hostCpus: 8,
    },
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  });

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  const app = impd.api.app.listen({ port: 0, hostname: '127.0.0.1' });

  stack.defer(async () => {
    await app.stop(true);
  });

  invariant(app.server?.port);

  const sendRequest = (request: Request) => impd.api.app.handle(request);

  return {
    stack,
    sendRequest,
    client: createImpClient({ url: 'http://impd.test', token: 'root-token', fetch: sendRequest }),
    url: `http://127.0.0.1:${String(app.server.port)}`,
  };
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

// impd's address is a closed port: a call would fail to connect, not refuse
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
  const result = await runCli({
    args,
    env: { IMP_URL: 'http://127.0.0.1:1', IMP_TOKEN: 'root-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result).toStrictEqual({ stdout: '', stderr, code: 2 });
});

test.each([
  [
    ['secret', 'add', 'gh', '--kind', 'github', '--replace'],
    'secretRebind',
    'is older than 0.27.0 and would let --replace change the hosts and keep every grant',
  ],
  [
    ['secret', 'add', 'gh', '--kind', 'github', '--replace', '--rebind'],
    'secretRebind',
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
    'oauthSecrets',
    'has no oauth secrets and would refuse the oauth kind',
  ],
  [
    ['secret', 'refresh', 'codex'],
    'oauthSecrets',
    'has no oauth secrets and would not know the command',
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
      'http://172.17.0.1:18081',
    ],
    'secretUpstream',
    'has no secret upstreams and would send the credential to the host itself',
  ],
])(
  'it makes no call past the feature check for %p on an impd from before %s',
  async (args, feature, reason) => {
    const ctx = await setupTest();

    const older = startStubOlderImpd(ctx.stack, ctx.sendRequest, { withoutFeatures: [feature] });

    const result = await runCli({
      args,
      env: { IMP_URL: older.url, IMP_TOKEN: 'root-token' },
      stdin: 'fake-secret-value\n',
    });

    expect(result).toStrictEqual({
      stdout: '',
      stderr: `imp: this impd ${reason}; nothing was changed. Upgrade impd, or use an older imp CLI\n`,
      code: 1,
    });

    expect(older.calls).toStrictEqual(['system/info']);
  },
);

test('it replaces no secret on an impd from before SystemInfo.features', async () => {
  const ctx = await setupTest();

  const older = startStubOlderImpd(ctx.stack, ctx.sendRequest, { isWithoutFeatureList: true });

  const result = await runCli({
    args: ['secret', 'add', 'gh', '--kind', 'github', '--replace'],
    env: { IMP_URL: older.url, IMP_TOKEN: 'root-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result.code).toBe(1);
  expect(older.calls).toStrictEqual(['system/info']);
});

test('it replaces no secret when the feature check’s connection drops', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'fake-old-value' });

  const impd = startStubInfoFaultImpd(ctx.stack, ctx.sendRequest);

  const result = await runCli({
    args: ['secret', 'add', 'gh', '--kind', 'github', '--replace'],
    env: { IMP_URL: impd.url, IMP_TOKEN: 'root-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'imp: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()\n',
    code: 1,
  });

  expect(impd.calls).toStrictEqual(['system/info']);
});

test('it replaces a secret on an impd with the feature', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'fake-old-value' });

  const result = await runCli({
    args: ['secret', 'add', 'gh', '--kind', 'github', '--replace'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result).toStrictEqual({
    stdout: [
      'NAME  KIND    STATE  HOSTS                                         IMPS',
      'gh    github  -      github.com,api.github.com,uploads.github.com  -',
      '',
    ].join('\n'),
    stderr: '',
    code: 0,
  });
});

test('it adds a plain secret without a feature check, even on an impd from before SystemInfo.features', async () => {
  const ctx = await setupTest();

  const older = startStubOlderImpd(ctx.stack, ctx.sendRequest, { isWithoutFeatureList: true });

  const result = await runCli({
    args: ['secret', 'add', 'gh', '--kind', 'github'],
    env: { IMP_URL: older.url, IMP_TOKEN: 'root-token' },
    stdin: 'fake-secret-value\n',
  });

  expect(result.code).toBe(0);
  expect(older.calls).toStrictEqual(['secrets/add']);
});

test('it says until when an added oauth secret’s access token is valid', async () => {
  const ctx = await setupTest();

  // an access token whose JWT expiry is 2030-01-01T00:00:00Z
  const accessToken = `e30.${Buffer.from(JSON.stringify({ exp: 1_893_456_000 })).toString('base64url')}.sig`;

  server.use(
    http.post('https://auth.example.com/oauth/token', () =>
      HttpResponse.json({ access_token: accessToken, refresh_token: 'fake-refresh-1' }),
    ),
  );

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
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
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
});

test('it says why an added oauth secret failed its sign-in', async () => {
  const ctx = await setupTest();

  server.use(
    http.post('https://auth.example.com/oauth/token', () =>
      HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
    ),
  );

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
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
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
  const ctx = await setupTest();

  // an access token whose JWT expiry is 2030-01-01T00:00:00Z
  const accessToken = `e30.${Buffer.from(JSON.stringify({ exp: 1_893_456_000 })).toString('base64url')}.sig`;

  server.use(
    http.post('https://auth.example.com/oauth/token', () =>
      HttpResponse.json({ access_token: accessToken, refresh_token: 'fake-refresh-1' }),
    ),
  );

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    oauth: {
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'json',
    },
  });

  const result = await runCli({
    args: ['secret', 'refresh', 'codex'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
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
  const ctx = await setupTest();

  server.use(
    http.post('https://auth.example.com/oauth/token', () =>
      HttpResponse.json({ error: 'temporarily_unavailable' }, { status: 503 }),
    ),
  );

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    oauth: {
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'json',
    },
  });

  const result = await runCli({
    args: ['secret', 'refresh', 'codex', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  const printed: unknown = JSON.parse(result.stdout);

  expect(printed).toStrictEqual({
    name: 'codex',
    kind: 'oauth',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    imps: [],
    createdAt: expect.any(String) as unknown,
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
  const ctx = await setupTest();

  server.use(
    http.post('https://auth.example.com/oauth/token', () =>
      HttpResponse.json({ error: 'refresh_token_reused' }, { status: 400 }),
    ),
  );

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'fake-secret-value' });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh',
    rules: [{ host: 'chatgpt.com', header: 'authorization', scheme: 'bearer' }],
    oauth: {
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'json',
    },
  });

  const result = await runCli({
    args: ['secret', 'ls'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  expect(result).toStrictEqual({
    stdout: [
      'NAME   KIND    STATE                               HOSTS                                         IMPS',
      'codex  oauth   needs_login (refresh_token_reused)  chatgpt.com                                   -',
      'gh     github  -                                   github.com,api.github.com,uploads.github.com  -',
      '',
    ].join('\n'),
    stderr: '',
    code: 0,
  });
});

test('it sends a secret upstream in the rule to an impd that knows it', async () => {
  const ctx = await setupTest();

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
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
    stdin: 'fake-token\n',
  });

  const secrets: unknown = await ctx.client.secrets.list();

  expect(result.code).toBe(0);

  expect(secrets).toStrictEqual([
    {
      name: 'op-connect',
      kind: 'custom',
      rules: [
        {
          host: 'op-connect.imp.internal',
          header: 'authorization',
          scheme: 'bearer',
          upstream: 'http://172.17.0.1:18081',
        },
      ],
      imps: [],
      createdAt: expect.toBeValidDate() as unknown,
    },
  ]);
});

test('it stores nothing when stdin gives an empty value', async () => {
  const ctx = await setupTest();

  const result = await runCli({
    args: ['secret', 'add', 'gh', '--kind', 'github'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
    stdin: '\n',
  });

  const secrets = await ctx.client.secrets.list();

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: no value given; nothing stored\n',
    code: 2,
  });

  expect(secrets).toBeEmpty();
});

test('it refuses an audit kind other than broker or api', async () => {
  const result = await runCli({
    args: ['audit', '--kind', 'tokens'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: 'imp: --kind is broker or api\n', code: 2 });
});
