import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import { createImage } from '@imp/daemon/src/db/images';
import { createImp, findImpByName, updateImpMove } from '@imp/daemon/src/db/imps';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import {
  buildImagePaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '@zgeoff/imp-client';
import { writeHostConfig } from '../host-store';
import { runCli } from '../test-utils/start-cli';
import { startStubOlderImpd } from '../test-utils/start-stub-older-impd';
import { startStubSilentHost } from '../test-utils/start-stub-silent-host';
import { listAllImps, listForkWarnings, readConsoleSession } from './imps';

// The CLI's home, and one real impd per entry of `hosts`, each on its own
// data dir and database and on a loopback port for the CLI child. `isPublic`
// lets imps.expose work; `isKsm` turns IMP_KSM on, with the `ksm` handle's saving
async function setupTest(hosts: readonly Readonly<{ isPublic?: boolean; isKsm?: boolean }>[] = []) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-cli-imps-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  // the CLI's home, where config.json keeps the saved hosts, so none of
  // this machine's reaches it
  const home = { HOME: dir, XDG_CONFIG_HOME: dir };

  // the resolver binds its port on every address, so each impd takes its own
  const dnsPorts = findFreePorts(Math.max(hosts.length, 1));
  const booted = [];

  for (const host of hosts) {
    const dataDir = await mkdtemp(join(tmpdir(), 'imp-cli-imps-impd-'));

    stack.defer(() => rm(dataDir, { recursive: true, force: true }));

    const db = await openDatabase(':memory:');

    stack.defer(() => db.destroy());

    // the stub VMM runs no jailer and builds no boot template
    const config = loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_EGRESS_DNS_PORT: String(dnsPorts.take()),
      ...(host.isPublic === true && {
        IMP_DOMAIN: 'imp.example.com',
        IMP_DNS_PROVIDER: 'cloudflare',
        IMP_DNS_API_TOKEN: 'unused',
        IMP_PUBLIC_IP: '203.0.113.7',
      }),
      ...(host.isKsm === true && { IMP_KSM: '1' }),
    });

    // the system drive impd boots imps with
    const drive = 'd1'.repeat(32);
    const systemDrivePath = buildSystemDrivePath(dataDir, drive);

    await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
    await writeFile(systemDrivePath, drive);

    const vmm = buildStubVmm();

    // what KSM saves in each awake VM, as /proc reports it
    const ksm = { profitMib: 0 };

    const impd = await createImpd(config, {
      db,

      // the bearer the CLI and the test's client send
      rootToken: 'imps-token',
      storage: createXfsBackend({
        dataDir,
        cloneFile: (source, target) => copyFile(source, target),
      }),
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
        readUnsharedRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
        checkGuestMerge: () => Promise.resolve(true),
        readKsmProfitMib: (pid) => {
          const profitMib = vmm.alive.has(pid) ? ksm.profitMib : null;

          return Promise.resolve(profitMib);
        },
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

    const client = createImpClient({
      url: 'http://impd.test',
      token: 'imps-token',
      fetch: (request) => impd.api.app.handle(request),
    });

    booted.push({
      url: `http://127.0.0.1:${String(app.server.port)}`,
      dataDir,
      db,
      client,
      ksm,
      fetch: (request: Request) => impd.api.app.handle(request),
    });
  }

  return { home, stack, hosts: booted };
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
  const ctx = await setupTest();

  // nothing listens there: a call would fail on the connection instead
  const result = await runCli({
    args,
    env: { ...ctx.home, IMP_URL: 'http://127.0.0.1:1', IMP_TOKEN: 'imps-token' },
  });

  expect(result).toStrictEqual({ stdout: '', stderr, code: 2 });
});

test('#exec runs nothing for --require on an impd older than 0.30.0, without execRequire', async () => {
  const ctx = await setupTest([{}]);

  const [box] = ctx.hosts;

  invariant(box);

  const older = startStubOlderImpd(ctx.stack, box.fetch, { withoutFeatures: ['execRequire'] });

  const result = await runCli({
    args: ['exec', 'box', '--require', 'broker', '--', 'true'],
    env: { ...ctx.home, IMP_URL: older.url, IMP_TOKEN: 'imps-token' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'imp: this impd is older than 0.30.0 and would run the command without checking --require; nothing was changed. Upgrade impd, or use an older imp CLI\n',
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

  expect(result).toStrictEqual({ stdout: '', stderr: 'imp: --log needs a session\n', code: 2 });
});

test('#console makes no call past the feature check for --log on an impd from before session logs', async () => {
  const ctx = await setupTest([{}]);

  const [box] = ctx.hosts;

  invariant(box);

  const older = startStubOlderImpd(ctx.stack, box.fetch, { withoutFeatures: ['sessionLog'] });

  const result = await runCli({
    args: ['console', 'dev', '--session', 'main', '--log'],
    env: { ...ctx.home, IMP_URL: older.url, IMP_TOKEN: 'imps-token' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'imp: this impd has no session logs and would start the session without a log; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(older.calls).toStrictEqual(['system/info']);
});

test('#ls lists every saved host and exits 3 when one of them fails', async () => {
  const ctx = await setupTest([{}, {}]);

  const [box, laptop] = ctx.hosts;

  invariant(box);
  invariant(laptop);

  await createImage(box.db, { name: 'base', ref: 'base:1', digest: 'sha256:base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, 'sha256:base').rootfs, 'rootfs');
  await box.client.imps.create({ name: 'web' });
  await box.client.imps.create({ name: 'db' });

  // db is on its way to another host
  const db = await findImpByName(box.db, 'db');

  invariant(db);

  await updateImpMove(box.db, db.id, 'sending');

  await createImage(laptop.db, {
    name: 'base',
    ref: 'base:1',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await Bun.write(buildImagePaths(laptop.dataDir, 'sha256:base').rootfs, 'rootfs');
  await laptop.client.imps.create({ name: 'dev' });
  await laptop.client.imps.sleep({ name: 'dev' });

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
    ['box', 'db', 'running'],
    ['box', 'web', 'running'],
    ['laptop', 'dev', 'sleeping'],
  ]);

  expect(rows[1]).toInclude('  sending');
  expect(listed.stderr).toMatch(/^imp: gone: [^\n]+\n$/u);
  expect(listed.code).toBe(3);
});

test('#listAllImps gives up on a host that never answers once its timer runs out', async () => {
  const ctx = await setupTest([{}]);

  const [box] = ctx.hosts;

  invariant(box);

  await createImage(box.db, { name: 'base', ref: 'base:1', digest: 'sha256:base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, 'sha256:base').rootfs, 'rootfs');
  await box.client.imps.create({ name: 'web' });

  // takes the connection and never answers, as a sleeping laptop's impd
  // does from behind a stalled tailnet path
  const silent = startStubSilentHost(ctx.stack);

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
  expect(silent.requests).toStrictEqual(['/rpc/imps/list']);
  expect(printError).toHaveBeenCalledExactlyOnceWith('imp: silent: no answer in 5 s');
  expect(code).toBe(3);
});

test('#ls never prints a saved token under --all', async () => {
  const ctx = await setupTest([{}]);

  const [box] = ctx.hosts;

  invariant(box);

  await createImage(box.db, { name: 'base', ref: 'base:1', digest: 'sha256:base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, 'sha256:base').rootfs, 'rootfs');
  await box.client.imps.create({ name: 'web' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'imps-token' },
      gone: { url: 'http://127.0.0.1:1', token: 'imps-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all'], env: ctx.home });

  expect(`${listed.stdout}${listed.stderr}`).not.toInclude('imps-token');
});

test('#ls writes the imps and the errors of every host as JSON for --all --json', async () => {
  const ctx = await setupTest([{}, {}]);

  const [box, laptop] = ctx.hosts;

  invariant(box);
  invariant(laptop);

  await createImage(box.db, { name: 'base', ref: 'base:1', digest: 'sha256:base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, 'sha256:base').rootfs, 'rootfs');
  await box.client.imps.create({ name: 'web' });
  await box.client.imps.create({ name: 'db' });

  await createImage(laptop.db, {
    name: 'base',
    ref: 'base:1',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await Bun.write(buildImagePaths(laptop.dataDir, 'sha256:base').rootfs, 'rootfs');
  await laptop.client.imps.create({ name: 'dev' });

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

  const boxImps = await box.client.imps.list();
  const laptopImps = await laptop.client.imps.list();

  // what the CLI received, dates as JSON writes them, with each imp's host;
  // the presenter reads awakeMs off the wall clock
  const sent: unknown = JSON.parse(
    JSON.stringify([
      ...boxImps.map((imp) => Object.assign(imp, { host: 'box' })),
      ...laptopImps.map((imp) => Object.assign(imp, { host: 'laptop' })),
    ]),
    (key, value: unknown) => (key === 'awakeMs' ? (expect.any(Number) as unknown) : value),
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
    expect.stringMatching(/^imp: away: /u) as unknown,
    expect.stringMatching(/^imp: gone: /u) as unknown,
  ]);

  expect(listed.code).toBe(1);
});

test('#ls lists every host’s builders under --all --builders', async () => {
  const ctx = await setupTest([{}, {}]);

  const [box, laptop] = ctx.hosts;

  invariant(box);
  invariant(laptop);

  // a builder imp on each host, as a host build leaves one
  const boxImage = await createImage(box.db, {
    name: 'base',
    ref: 'base:1',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await createImp(box.db, {
    name: 'box-builder',
    imageId: boxImage.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 9,
    ip: '10.66.0.9',
    kind: 'builder',
  });

  const laptopImage = await createImage(laptop.db, {
    name: 'base',
    ref: 'base:1',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await createImp(laptop.db, {
    name: 'laptop-builder',
    imageId: laptopImage.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 9,
    ip: '10.66.0.9',
    kind: 'builder',
  });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'imps-token' },
      laptop: { url: laptop.url, token: 'imps-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--all', '--builders', '--json'], env: ctx.home });

  const body: unknown = JSON.parse(listed.stdout);

  expect(body).toMatchObject({
    imps: [
      { host: 'box', name: 'box-builder' },
      { host: 'laptop', name: 'laptop-builder' },
    ],
    errors: [],
  });
});

test('#ls lists no builder under plain --all', async () => {
  const ctx = await setupTest([{}, {}]);

  const [box, laptop] = ctx.hosts;

  invariant(box);
  invariant(laptop);

  // a builder imp on each host, as a host build leaves one
  const boxImage = await createImage(box.db, {
    name: 'base',
    ref: 'base:1',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await createImp(box.db, {
    name: 'box-builder',
    imageId: boxImage.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 9,
    ip: '10.66.0.9',
    kind: 'builder',
  });

  const laptopImage = await createImage(laptop.db, {
    name: 'base',
    ref: 'base:1',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await createImp(laptop.db, {
    name: 'laptop-builder',
    imageId: laptopImage.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 9,
    ip: '10.66.0.9',
    kind: 'builder',
  });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'imps-token' },
      laptop: { url: laptop.url, token: 'imps-token' },
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
    stderr: 'imp: --all lists every saved host; drop --host\n',
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
    stderr: 'imp: --place picks among the saved hosts; drop --host\n',
    code: 2,
  });
});

test('#ls lists the current host alone without --all', async () => {
  const ctx = await setupTest([{}]);

  const [box] = ctx.hosts;

  invariant(box);

  await createImage(box.db, { name: 'base', ref: 'base:1', digest: 'sha256:base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, 'sha256:base').rootfs, 'rootfs');
  await box.client.imps.create({ name: 'db' });

  // nothing listens at laptop's URL: asking it would print its error
  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: {
      box: { url: box.url, token: 'imps-token' },
      laptop: { url: 'http://127.0.0.1:1', token: 'imps-token' },
    },
  });

  const listed = await runCli({ args: ['ls', '--json'], env: ctx.home });
  const imps = await box.client.imps.list();

  // dates as JSON writes them; the presenter reads awakeMs off the wall clock
  const sent: unknown = JSON.parse(JSON.stringify(imps), (key, value: unknown) =>
    key === 'awakeMs' ? (expect.any(Number) as unknown) : value,
  );

  expect({ ...listed, stdout: JSON.parse(listed.stdout) as unknown }).toStrictEqual({
    stdout: sent,
    stderr: '',
    code: 0,
  });
});

test('#new skips a host without the image and moves past a RAM refusal under --place', async () => {
  const ctx = await setupTest([{ isKsm: true }, {}, {}]);

  const [big, small, bare] = ctx.hosts;

  invariant(big);
  invariant(small);
  invariant(bare);

  // big: the most free RAM by system.info, but a held imp whose KSM saving
  // the governor keeps free leaves no room for a boot
  await createImage(big.db, { name: 'base', ref: 'base:1', digest: 'sha256:base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(big.dataDir, 'sha256:base').rootfs, 'rootfs');
  await big.client.imps.create({ name: 'held' });
  await big.client.leases.acquire({ name: 'held', label: 'work', ttlSeconds: 3600 });

  big.ksm.profitMib = 16_000;

  // small: two awake imps, so less free RAM than big
  await createImage(small.db, {
    name: 'base',
    ref: 'base:1',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await Bun.write(buildImagePaths(small.dataDir, 'sha256:base').rootfs, 'rootfs');
  await small.client.imps.create({ name: 'web' });
  await small.client.imps.create({ name: 'db' });

  // bare: the most free RAM of all, but not the image asked for
  await createImage(bare.db, {
    name: 'ubuntu',
    ref: 'ubuntu:1',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await Bun.write(buildImagePaths(bare.dataDir, 'sha256:ubuntu').rootfs, 'rootfs');

  writeHostConfig(ctx.home, {
    current: 'big',
    hosts: {
      big: { url: big.url, token: 'imps-token' },
      small: { url: small.url, token: 'imps-token' },
      bare: { url: bare.url, token: 'imps-token' },
    },
  });

  const placed = await runCli({
    args: ['new', 'dev', '--image', 'base', '--place', '--json'],
    env: ctx.home,
  });

  const body: unknown = JSON.parse(placed.stdout);

  const created = await small.client.imps.get({ name: 'dev' });

  // dates as JSON writes them; the presenter reads awakeMs off the wall clock
  const sent: unknown = JSON.parse(
    JSON.stringify({ host: 'small', imp: created }),
    (key, value: unknown) => (key === 'awakeMs' ? (expect.any(Number) as unknown) : value),
  );

  expect(placed.stderr).toBe(
    [
      'imp: bare: skipped: it has no image base',
      'imp: placing on big',
      'imp: big: not enough RAM: 17024 of 16384 MiB in use, 1024 MiB requested, and no idle imp left to sleep; trying the next host',
      'imp: placing on small',
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

test('#new refuses --place for a name a saved host has already', async () => {
  const ctx = await setupTest([{}, {}]);

  const [box, laptop] = ctx.hosts;

  invariant(box);
  invariant(laptop);

  await createImage(box.db, { name: 'base', ref: 'base:1', digest: 'sha256:base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, 'sha256:base').rootfs, 'rootfs');
  await box.client.imps.create({ name: 'web' });

  await createImage(laptop.db, {
    name: 'base',
    ref: 'base:1',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await Bun.write(buildImagePaths(laptop.dataDir, 'sha256:base').rootfs, 'rootfs');
  await laptop.client.imps.create({ name: 'dev' });

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

  const boxDev = await findImpByName(box.db, 'dev');

  expect(boxDev).toBeUndefined();
});

test('#new passes over a host whose token is limited, then exposes, under --place --public', async () => {
  const ctx = await setupTest([{}, { isPublic: true }]);

  const [big, small] = ctx.hosts;

  invariant(big);
  invariant(small);

  await createImage(big.db, { name: 'base', ref: 'base:1', digest: 'sha256:base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(big.dataDir, 'sha256:base').rootfs, 'rootfs');

  // big's saved token reaches only some imps
  const limited = await big.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev*'],
  });

  await createImage(small.db, {
    name: 'base',
    ref: 'base:1',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await Bun.write(buildImagePaths(small.dataDir, 'sha256:base').rootfs, 'rootfs');

  writeHostConfig(ctx.home, {
    current: 'big',
    hosts: {
      big: { url: big.url, token: limited.secret },
      small: { url: small.url, token: 'imps-token' },
    },
  });

  const placed = await runCli({
    args: ['new', 'dev', '--place', '--public', '--json'],
    env: ctx.home,
  });

  const body: unknown = JSON.parse(placed.stdout);

  // the create's answer, from before the expose
  const { public: _exposed, ...created } = await small.client.imps.get({ name: 'dev' });

  // dates as JSON writes them; the presenter reads awakeMs off the wall clock
  const imp: unknown = JSON.parse(JSON.stringify(created), (key, value: unknown) =>
    key === 'awakeMs' ? (expect.any(Number) as unknown) : value,
  );

  expect(placed.stderr).toBe(
    [
      'imp: big: skipped: its token is limited to some imps, which --public and --net need it not to be',
      'imp: placing on small',
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
  const ctx = await setupTest([{}]);

  const [box] = ctx.hosts;

  invariant(box);

  // box has no IMP_PUBLIC_IP, so its expose fails
  await createImage(box.db, { name: 'base', ref: 'base:1', digest: 'sha256:base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, 'sha256:base').rootfs, 'rootfs');

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: 'imps-token' } },
  });

  const placed = await runCli({
    args: ['new', 'dev', '--place', '--public', '--json'],
    env: ctx.home,
  });

  const body: unknown = JSON.parse(placed.stdout);

  const created = await box.client.imps.get({ name: 'dev' });

  // dates as JSON writes them; the presenter reads awakeMs off the wall clock
  const sent: unknown = JSON.parse(
    JSON.stringify({
      host: 'box',
      imp: created,
      error: 'PRECONDITION_FAILED: public imps need IMP_DOMAIN and IMP_PUBLIC_IP on the host',
    }),
    (key, value: unknown) => (key === 'awakeMs' ? (expect.any(Number) as unknown) : value),
  );

  expect(placed.stderr).toBe(
    'imp: placing on box\nimp: dev was created on box; PRECONDITION_FAILED: public imps need IMP_DOMAIN and IMP_PUBLIC_IP on the host\n',
  );

  expect(body).toStrictEqual(sent);
  expect(placed.code).toBe(1);
});
