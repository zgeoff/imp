import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '@zgeoff/imp-client';
import packageJson from '../package.json' with { type: 'json' };
import { loadConfig } from './config';
import { createImpd } from './create-impd';
import { listApiCalls } from './db/api-audit';
import { createImage } from './db/images';
import { openDatabase } from './db/open-database';
import { MIGRATIONS } from './db/run-migrations';
import { buildSystemDrivePath, buildSystemDrivesDir } from './storage/data-layout';
import { createXfsBackend } from './storage/xfs-backend';
import { buildStubCpuCgroups } from './test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from './test-utils/build-stub-vmm';
import { findFreePorts } from './test-utils/find-free-ports';

// system.copyDatabase through the API (docs/guides/operations.md#database-copy-and-restore)

// impd's real app on stub VMs, with its database and data dir, and a root
// client that reaches the app in process
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'build-app-database-copy-'));

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

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const impd = await createImpd(config, {
    db,

    // the bearer the root client sends
    rootToken: 'root-token',
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),

    // what system.info reports; the drive's hash names the drive file above
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },

    // the host's free space, so a copy never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},

    // a frozen clock, so a copy's name and creation time are known
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),

    // Firecracker, the kernel and the CPU as this host reports them
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

  // the image every imps.create boots when it names none
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const sendToImpd = (request: Request) => impd.api.app.handle(request);

  return {
    db,
    dataDir,
    sendToImpd,
    client: createImpClient({ url: 'http://impd.test', token: 'root-token', fetch: sendToImpd }),
  };
}

test('it answers a copy with its fields in the order a restore script reads them', async () => {
  const ctx = await setupTest();
  const copy = await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  expect(Object.keys(copy)).toStrictEqual([
    'path',
    'sizeBytes',
    'lastMigration',
    'impVersion',
    'createdAt',
    'integrity',
  ]);
});

test('it answers a copy with its path, size, schema version, impd version and time', async () => {
  const ctx = await setupTest();
  const copy = await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  const path = join(ctx.dataDir, 'db-copies', 'before-upgrade.sqlite');

  // the schema version is the newest migration this impd holds
  const lastMigration = Object.keys(MIGRATIONS).toSorted().at(-1);

  invariant(lastMigration);

  expect(copy).toStrictEqual({
    path,
    sizeBytes: statSync(path).size,
    lastMigration,
    impVersion: packageJson.version,
    createdAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    integrity: 'ok',
  });
});

test('it writes the copy owner-only in an owner-only directory', async () => {
  const ctx = await setupTest();

  await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  expect(statSync(join(ctx.dataDir, 'db-copies', 'before-upgrade.sqlite')).mode & 0o777).toBe(
    0o600,
  );

  expect(statSync(join(ctx.dataDir, 'db-copies')).mode & 0o777).toBe(0o700);
});

test('it copies the rows the database holds', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  const opened = new Database(join(ctx.dataDir, 'db-copies', 'before-upgrade.sqlite'), {
    readonly: true,
  });

  onTestFinished(() => {
    opened.close();
  });

  expect(opened.query('SELECT name FROM imps').all()).toStrictEqual([{ name: 'dev' }]);
});

test('it records the copy in the API audit log', async () => {
  const ctx = await setupTest();

  await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  // each audit row lands after its answer
  const audit = await waitFor(async () => {
    const calls = await listApiCalls(ctx.db, null, 100, null);

    const copies = calls.filter((call) => call.procedure === 'system.copyDatabase');

    expect(copies).toHaveLength(1);

    return copies;
  });

  expect(audit).toMatchObject([{ actor: 'token', outcome: 'ok' }]);
});

test('it names a copy without a name for the time it was taken', async () => {
  const ctx = await setupTest();
  const copy = await ctx.client.system.copyDatabase({});

  expect(copy.path).toBe(join(ctx.dataDir, 'db-copies', 'imp-20260102-030405.sqlite'));
});

test('it refuses a name a copy already has with a conflict', async () => {
  const ctx = await setupTest();

  await ctx.client.system.copyDatabase({ name: 'before-upgrade' });

  expect(ctx.client.system.copyDatabase({ name: 'before-upgrade' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test.each([['../../etc/x'], ['/tmp/x']])('it refuses %s as a copy name', async (name) => {
  const ctx = await setupTest();

  expect(ctx.client.system.copyDatabase({ name })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

test('it refuses a copy to a manage token limited to some imps', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'scoped', scope: 'manage', imps: ['dev*'] });

  const scoped = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(scoped.system.copyDatabase({ name: 'scoped' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

test('it lets a host-wide manage token copy', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'host-wide', scope: 'manage' });

  const hostWide = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  const copy = await hostWide.system.copyDatabase({ name: 'host-wide' });

  expect(copy.path).toBe(join(ctx.dataDir, 'db-copies', 'host-wide.sqlite'));
});
