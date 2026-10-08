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
import { createImpClient } from '@zgeoff/imp-client';
import { runCli } from '../test-utils/start-cli';
import { startStubInfoFaultImpd } from '../test-utils/start-stub-info-fault-impd';
import { startStubOlderImpd } from '../test-utils/start-stub-older-impd';

// impd's real app, listening on a loopback port for the spawned CLI, and an
// in-process client of it
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'cli-tokens-'));

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

// impd's address is a closed port: a call would fail to connect, not refuse
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
  const result = await runCli({
    args,
    env: { IMP_URL: 'http://127.0.0.1:1', IMP_TOKEN: 'root-token' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr, code: 2 });
});

test.each([
  [
    ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    'grantableTokens',
    'is older than 0.27.0 and would drop --grantable and make the token without that limit',
  ],
  [
    ['token', 'set', 'agent', '--grantable', 'gh'],
    'tokenUpdate',
    'is older than 0.34.0 and would not know tokens.update',
  ],
])(
  'it makes no call past the feature check for %p on an impd from before %s',
  async (args, feature, reason) => {
    const ctx = await setupTest();

    const older = startStubOlderImpd(ctx.stack, ctx.sendRequest, { withoutFeatures: [feature] });

    const result = await runCli({ args, env: { IMP_URL: older.url, IMP_TOKEN: 'root-token' } });

    expect(result).toStrictEqual({
      stdout: '',
      stderr: `imp: this impd ${reason}; nothing was changed. Upgrade impd, or use an older imp CLI\n`,
      code: 1,
    });

    expect(older.calls).toStrictEqual(['system/info']);
  },
);

test('it creates no token on an impd from before SystemInfo.features', async () => {
  const ctx = await setupTest();

  const older = startStubOlderImpd(ctx.stack, ctx.sendRequest, { isWithoutFeatureList: true });

  const result = await runCli({
    args: ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    env: { IMP_URL: older.url, IMP_TOKEN: 'root-token' },
  });

  expect(result.code).toBe(1);
  expect(older.calls).toStrictEqual(['system/info']);
});

test('it creates no token when the feature check’s connection drops', async () => {
  const ctx = await setupTest();

  const impd = startStubInfoFaultImpd(ctx.stack, ctx.sendRequest);

  const result = await runCli({
    args: ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    env: { IMP_URL: impd.url, IMP_TOKEN: 'root-token' },
  });

  const tokens = await ctx.client.tokens.list();

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'imp: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()\n',
    code: 1,
  });

  expect(impd.calls).toStrictEqual(['system/info']);
  expect(tokens.map((token) => token.name)).not.toContain('agent');
});

test('it creates a grantable token on an impd with the feature', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'fake-secret-value' });

  const result = await runCli({
    args: ['token', 'new', 'agent', '--scope', 'manage', '--imps', 'agent-*', '--grantable', 'gh'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  const tokens: unknown = await ctx.client.tokens.list();

  const received: unknown = result;

  expect(received).toStrictEqual({
    stdout: expect.stringMatching(/^imp_\S+\n$/u) as unknown,
    stderr: 'imp: token agent made; impd shows its secret only this once\n',
    code: 0,
  });

  expect(tokens).toStrictEqual([
    {
      name: 'agent',
      scope: 'manage',
      imps: ['agent-*'],
      sshKeys: [],
      grantable: ['gh'],
      createdAt: expect.toBeValidDate() as unknown,
    },
  ]);
});

test('it sends the grantable list on token set to an impd with tokens.update', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'fake-secret-value' });
  await ctx.client.tokens.create({ name: 'agent', scope: 'manage', imps: ['agent-*'] });

  const result = await runCli({
    args: ['token', 'set', 'agent', '--grantable', 'gh', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  const printed: unknown = JSON.parse(result.stdout);

  expect(printed).toStrictEqual({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
    sshKeys: [],
    grantable: ['gh'],
    createdAt: expect.any(String) as unknown,
  });
});

test('it clears the grantable list on token set with an empty --grantable', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'fake-secret-value' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
    grantable: ['gh'],
  });

  const result = await runCli({
    args: ['token', 'set', 'agent', '--grantable', '', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  const printed: unknown = JSON.parse(result.stdout);

  expect(printed).toStrictEqual({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
    sshKeys: [],
    grantable: [],
    createdAt: expect.any(String) as unknown,
  });
});

test('it names a token it cannot find on token key ls', async () => {
  const ctx = await setupTest();

  const result = await runCli({
    args: ['token', 'key', 'ls', 'ci'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: 'imp: no token named ci\n', code: 2 });
});
