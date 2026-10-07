import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import { createImage } from '@imp/daemon/src/db/images';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import {
  buildImpPaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { invariant } from '@imp/test-utils/invariant';
import { createImpClient } from '@zgeoff/imp-client';
import { runCli } from '../test-utils/start-cli';
import { startStubServiceAgent } from '../test-utils/start-stub-service-agent';
import { UsageError } from '../usage-error';
import { buildServiceDef, createLogPrinter, formatLogEvent } from './services';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dataDir = await mkdtemp(join(tmpdir(), 'cli-services-'));

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

  // each boot reports an agent with the services API (0.10.0)
  vmm.agent.version = '0.10.0';

  const impd = await createImpd(config, {
    db,
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

    // the host's free space, so a create never meets this machine's disk
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

  const port = app.server?.port;

  invariant(port);

  const client = createImpClient({
    url: 'http://impd.test',
    token: 'root-token',
    fetch: (request) => impd.api.app.handle(request),
  });

  // the image a test's imps boot from
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const owned = stack.move();

  return {
    dataDir,
    client,
    url: `http://127.0.0.1:${String(port)}`,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('#buildServiceDef runs --cmd through the shell', () => {
  expect(buildServiceDef('web', { cmd: 'node server.js', argv: [] })).toStrictEqual({
    name: 'web',
    argv: ['/bin/sh', '-c', 'node server.js'],
  });
});

test('#buildServiceDef takes the words after -- as the argv and the flags for the rest', () => {
  const def = buildServiceDef('web', {
    argv: ['busybox', 'httpd', '-f'],
    env: ['PORT=3000', 'MODE=dev'],
    cwd: '/srv',
    user: 'www-data',
    restart: 'on-failure',
  });

  expect(def).toStrictEqual({
    name: 'web',
    argv: ['busybox', 'httpd', '-f'],
    env: ['PORT=3000', 'MODE=dev'],
    cwd: '/srv',
    user: 'www-data',
    restart: 'on-failure',
  });
});

test('#buildServiceDef takes one --env given as a string', () => {
  expect(buildServiceDef('web', { argv: ['x'], env: 'ONE=1' })).toStrictEqual({
    name: 'web',
    argv: ['x'],
    env: ['ONE=1'],
  });
});

test.each([
  ['no command', { argv: [] }, 'give the command once: --cmd "…" or after --'],
  [
    'a command given twice',
    { cmd: 'a', argv: ['b'] },
    'give the command once: --cmd "…" or after --',
  ],
  ['an --env with no =', { argv: ['x'], env: 'NOEQUALS' }, '--env NOEQUALS: want KEY=VALUE'],
  [
    'an --env key that starts with a digit',
    { argv: ['x'], env: ['1X=2'] },
    '--env 1X=2: want KEY=VALUE',
  ],
  [
    'an unknown --restart',
    { argv: ['x'], restart: 'sometimes' },
    '--restart must be one of always, on-failure, never',
  ],
])('#buildServiceDef refuses %s as a usage error', (_case, args, message) => {
  expect(() => buildServiceDef('web', args)).toThrowWithMessage(UsageError, message);
});

test('#createLogPrinter gives each whole line its service’s name with a prefix', () => {
  const write = mock<(text: string) => void>();
  const printer = createLogPrinter(true, write);

  printer.print({ type: 'log', service: 'web', text: 'GET /\nGET /a' });
  printer.print({ type: 'log', service: 'db', text: 'ready\n' });
  printer.print({ type: 'log', service: 'web', text: 'bc\n' });
  printer.print({ type: 'log', service: 'db', text: 'tail with no end' });
  printer.flush();

  expect(write.mock.calls).toStrictEqual([
    ['web | GET /\n'],
    ['db | ready\n'],
    ['web | GET /abc\n'],
    ['db | tail with no end\n'],
  ]);
});

test('#createLogPrinter writes a line longer than 64 KiB in pieces, each with the prefix', () => {
  const write = mock<(text: string) => void>();
  const printer = createLogPrinter(true, write);

  printer.print({ type: 'log', service: 'web', text: 'x'.repeat(65_536 * 2 + 3) });
  printer.flush();

  expect(write.mock.calls).toStrictEqual([
    [`web | ${'x'.repeat(65_536)}\n`],
    [`web | ${'x'.repeat(65_536)}\n`],
    ['web | xxx\n'],
  ]);
});

test('#createLogPrinter writes text as it comes without a prefix', () => {
  const write = mock<(text: string) => void>();
  const printer = createLogPrinter(false, write);

  printer.print({ type: 'log', service: 'web', text: 'GET' });
  printer.print({ type: 'log', service: 'web', text: ' /\n' });
  printer.flush();

  expect(write.mock.calls).toStrictEqual([['GET'], [' /\n']]);
});

test.each([
  [
    'sleeping',
    { type: 'sleeping', state: 'sleeping' },
    'box is sleeping; waiting for it to run (a follow does not wake it)',
  ],
  ['awake', { type: 'awake' }, 'box runs again'],
  ['restarting', { type: 'restarting' }, 'impd is restarting; the follow ends'],
] as const)('#formatLogEvent says what a %s event means for a follow', (_case, event, line) => {
  expect(formatLogEvent('box', event)).toBe(line);
});

test('#serviceCommand sends the definition to the guest with --env given more than once', async () => {
  await using ctx = await setupTest();

  const imp = await ctx.client.imps.create({ name: 'box' });
  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket);

  onTestFinished(() => {
    agent.close();
  });

  const result = await runCli({
    args: [
      'service',
      'add',
      'box',
      'web',
      '--env',
      'A=1',
      '--env=B=2',
      '--replace',
      '--cmd',
      'httpd -f',
    ],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr: '', code: 0 });

  expect(agent.requests).toStrictEqual([
    {
      op: 'services.add',
      def: { name: 'web', argv: ['/bin/sh', '-c', 'httpd -f'], env: ['A=1', 'B=2'] },
      replace: true,
    },
  ]);
});

test('#serviceCommand adds the service and then sets the imp’s HTTP port for --http-port', async () => {
  await using ctx = await setupTest();

  const imp = await ctx.client.imps.create({ name: 'box' });
  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket);

  onTestFinished(() => {
    agent.close();
  });

  const result = await runCli({
    args: ['service', 'add', 'box', 'web', '--cmd', 'httpd -f -p 8081', '--http-port', '8081'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  const updated = await ctx.client.imps.get({ name: 'box' });

  expect(result).toStrictEqual({ stdout: '', stderr: '', code: 0 });
  expect(updated.httpPort).toBe(8081);
});

test('#serviceCommand says the service runs and how to set the port when an exec token may not set it', async () => {
  await using ctx = await setupTest();

  const imp = await ctx.client.imps.create({ name: 'box' });
  const made = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });
  const agent = await startStubServiceAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket);

  onTestFinished(() => {
    agent.close();
  });

  const result = await runCli({
    args: ['service', 'add', 'box', 'web', '--cmd', 'httpd', '--http-port', '8081'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: made.secret },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'imp: service web was added and runs, but the HTTP port was not set: setting the HTTP port needs a token with manage. Run `imp set box --http-port 8081` to set it.\n',
    code: 1,
  });
});

test('#serviceCommand refuses a bad --http-port before it calls impd', async () => {
  const result = await runCli({
    args: ['service', 'add', 'box', 'web', '--cmd', 'httpd', '--http-port', '70000'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: --http-port must be a port from 1 to 65535\n',
    code: 2,
  });
});

test('#serviceCommand says when a sleeping imp’s last sleep recorded no list', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });
  await ctx.client.imps.sleep({ name: 'box' });

  const result = await runCli({
    args: ['service', 'ls', 'box', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  expect(result).toStrictEqual({
    stdout: '[]\n',
    stderr: 'box is sleeping, and its last sleep recorded no services list\n',
    code: 0,
  });
});

test('#logsCommand refuses a line count that is not a number before it calls impd', async () => {
  const result = await runCli({
    args: ['logs', 'box', '-n', 'ten'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: --lines must be a whole number from 0 to 100000\n',
    code: 2,
  });
});
