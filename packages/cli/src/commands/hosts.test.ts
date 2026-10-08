import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { readHostConfig, resolveConfigPath, writeHostConfig } from '../host-store';
import { runCli } from '../test-utils/start-cli';

// The CLI's home, and a real impd on a loopback port that the CLI child
// reaches as a user's would
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-login-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  // the CLI's home: config.json lives under XDG_CONFIG_HOME
  const env = { HOME: dir, XDG_CONFIG_HOME: dir };

  const dataDir = await mkdtemp(join(tmpdir(), 'imp-login-impd-'));

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

  // the system drive impd boots imps with
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const impd = await createImpd(config, {
    db,

    // the token impd takes
    rootToken: 'login-token',
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },

    // the host's free space, so impd never reads this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},
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
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: () =>
      Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] }),
    cgroups: buildStubCpuCgroups().cgroups,
    vms: vmm.startGeneration(),
    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },
    broker: {
      installBundle: () => Promise.resolve(),
      resolveTunnelTarget: () => Promise.reject(new Error('no network in tests')),
      runOAuthTimer: false,
    },
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

  return { env, url: `http://127.0.0.1:${String(app.server.port)}` };
}

test('it saves the host as current when impd accepts the token', async () => {
  const ctx = await setupTest();

  const login = await runCli({
    args: ['login', ctx.url, '--name', 'home'],
    env: ctx.env,
    stdin: 'login-token\n',
  });

  expect(login).toStrictEqual({
    stdout: `logged in to ${ctx.url} as home, now the current host\n`,
    stderr: '',
    code: 0,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({
    current: 'home',
    hosts: { home: { url: ctx.url, token: 'login-token' } },
  });
});

test('it lists the saved hosts without their tokens', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: 'home',
    hosts: { home: { url: 'https://home.example', token: 'login-token' } },
  });

  const listed = await runCli({ args: ['hosts'], env: ctx.env });

  expect(listed).toStrictEqual({
    stdout: '   NAME  URL                   TOKEN\n*  home  https://home.example  saved\n',
    stderr: '',
    code: 0,
  });
});

test('it saves nothing when impd refuses the token', async () => {
  const ctx = await setupTest();
  const login = await runCli({ args: ['login', ctx.url], env: ctx.env, stdin: 'wrong\n' });

  expect(login).toStrictEqual({
    stdout: '',
    stderr: `imp: ${ctx.url} refused the token; nothing saved\n`,
    code: 1,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({ current: null, hosts: {} });
});

test('it saves nothing when the token is empty', async () => {
  const ctx = await setupTest();

  // nothing listens there: a check would fail on the connection instead
  const login = await runCli({ args: ['login', 'http://127.0.0.1:1'], env: ctx.env, stdin: '\n' });

  expect(login).toStrictEqual({
    stdout: '',
    stderr: 'imp: no token given; nothing saved\n',
    code: 2,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({ current: null, hosts: {} });
});

test('it saves nothing when impd is out of reach', async () => {
  const ctx = await setupTest();

  const login: unknown = await runCli({
    args: ['login', 'http://127.0.0.1:1'],
    env: ctx.env,
    stdin: 'login-token\n',
  });

  expect(login).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(
      /^imp: cannot check the token with http:\/\/127\.0\.0\.1:1: .+; nothing saved\n$/u,
    ) as unknown,
    code: 1,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({ current: null, hosts: {} });
});

test('it saves without asking impd and warns of plain http under --no-verify', async () => {
  const ctx = await setupTest();

  const login = await runCli({
    args: ['login', 'http://imp.example:7070', '--no-verify'],
    env: ctx.env,
    stdin: 'login-token\n',
  });

  expect(login).toStrictEqual({
    stdout: 'logged in to http://imp.example:7070 as imp, now the current host\n',
    stderr:
      'imp: warning: http://imp.example:7070 is plain http; the token crosses the network unencrypted\n',
    code: 0,
  });

  expect(readHostConfig(ctx.env)).toStrictEqual({
    current: 'imp',
    hosts: { imp: { url: 'http://imp.example:7070', token: 'login-token' } },
  });
});

test('it leaves a damaged config.json as it was and asks impd nothing on login', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, { current: null, hosts: {} });

  await writeFile(resolveConfigPath(ctx.env), '{ damaged', { mode: 0o600 });

  // nothing listens there: a check would fail on the connection instead
  const login: unknown = await runCli({
    args: ['login', 'http://127.0.0.1:1'],
    env: ctx.env,
    stdin: 'login-token\n',
  });

  expect(login).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(/is not valid JSON; fix or remove it\n$/u) as unknown,
    code: 2,
  });

  const config = await readFile(resolveConfigPath(ctx.env), 'utf8');

  expect(config).toBe('{ damaged');
});

test('it makes a saved host current on host use', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: 'home',
    hosts: {
      home: { url: 'https://home.example', token: 'home-token' },
      work: { url: 'https://work.example', token: 'work-token' },
    },
  });

  const used = await runCli({ args: ['host', 'use', 'work'], env: ctx.env });

  expect(used.code).toBe(0);
  expect(readHostConfig(ctx.env).current).toBe('work');
});

test('it refuses a host use of a host it has not saved', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: 'home',
    hosts: { home: { url: 'https://home.example', token: 'home-token' } },
  });

  const used = await runCli({ args: ['host', 'use', 'nope'], env: ctx.env });

  expect(used).toStrictEqual({
    stdout: '',
    stderr: 'imp: no saved host nope (see imp host ls)\n',
    code: 2,
  });

  expect(readHostConfig(ctx.env).current).toBe('home');
});

test('it forgets the current host and clears current on host rm', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: 'work',
    hosts: {
      home: { url: 'https://home.example', token: 'home-token' },
      work: { url: 'https://work.example', token: 'work-token' },
    },
  });

  const removed = await runCli({ args: ['host', 'rm', 'work'], env: ctx.env });

  expect(removed.code).toBe(0);

  expect(readHostConfig(ctx.env)).toStrictEqual({
    current: null,
    hosts: { home: { url: 'https://home.example', token: 'home-token' } },
  });
});

test('it sends the saved token of --host over IMP_TOKEN, with a note', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, {
    current: null,
    hosts: { work: { url: ctx.url, token: 'login-token' } },
  });

  const listed = await runCli({
    args: ['--host', 'work', 'ls', '--json'],
    env: { ...ctx.env, IMP_TOKEN: 'ignored' },
  });

  expect(listed).toStrictEqual({
    stdout: '[]\n',
    stderr: 'imp: note: IMP_TOKEN is ignored; work uses its saved token\n',
    code: 0,
  });
});

test('it names the --host in a 401 for a saved token impd refuses', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, { current: null, hosts: { work: { url: ctx.url, token: 'stale' } } });

  const listed = await runCli({ args: ['--host', 'work', 'ls'], env: ctx.env });

  expect(listed).toStrictEqual({
    stdout: '',
    stderr: `imp: unauthorized: work (${ctx.url}) refused the token; run imp login ${ctx.url} --name work\n`,
    code: 1,
  });
});

test('it names the --host when impd refuses the saved token on exec’s socket', async () => {
  const ctx = await setupTest();

  writeHostConfig(ctx.env, { current: null, hosts: { work: { url: ctx.url, token: 'stale' } } });

  const exec = await runCli({
    args: ['--host', 'work', 'exec', 'box', '--', 'true'],
    env: ctx.env,
  });

  expect(exec).toStrictEqual({
    stdout: '',
    stderr: `imp: unauthorized: work (${ctx.url}) refused the token; run imp login ${ctx.url} --name work\n`,
    code: 255,
  });
});

test('it refuses --host without a saved host name', async () => {
  const ctx = await setupTest();
  const listed = await runCli({ args: ['ls', '--host'], env: ctx.env });

  expect(listed).toStrictEqual({
    stdout: '',
    stderr: 'imp: --host needs a saved host name (see imp host ls)\n',
    code: 2,
  });
});

test('it prints the version with --host and no saved host', async () => {
  const ctx = await setupTest();
  const version: unknown = await runCli({ args: ['--host', 'work', '--version'], env: ctx.env });

  expect(version).toStrictEqual({
    stdout: expect.stringMatching(/^\d+\.\d+\.\d+\n$/u) as unknown,
    stderr: '',
    code: 0,
  });
});

test('it prints the help with --host and no saved host', async () => {
  const ctx = await setupTest();
  const help: unknown = await runCli({ args: ['--host', 'work', '--help'], env: ctx.env });

  expect(help).toStrictEqual({
    stdout: expect.stringContaining('--host') as unknown,
    stderr: '',
    code: 0,
  });
});

test('it prints one line, not a stack, when exec cannot read config.json', async () => {
  const ctx = await setupTest();

  await mkdir(resolveConfigPath(ctx.env), { recursive: true });

  const exec: unknown = await runCli({ args: ['exec', 'box', '--', 'true'], env: ctx.env });

  expect(exec).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(/^imp: [^\n]*EISDIR[^\n]*\n$/u) as unknown,
    code: 255,
  });
});
