import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import packageJson from '@imp/daemon/package.json' with { type: 'json' };
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import { MIGRATIONS } from '@imp/daemon/src/db/run-migrations';
import { buildSystemDrivePath, buildSystemDrivesDir } from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { invariant } from '@imp/test-utils/invariant';
import * as z from 'zod';
import { runCli } from '../test-utils/start-cli';
import { startStubOlderImpd } from '../test-utils/start-stub-older-impd';

// impd's real app, listening on a loopback port for the spawned CLI
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'cli-db-'));

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

  return {
    stack,
    dataDir,
    sendRequest: (request: Request) => impd.api.app.handle(request),
    url: `http://127.0.0.1:${String(app.server.port)}`,
  };
}

test('it makes no database copy on an impd from before databaseCopy (0.30.0)', async () => {
  const ctx = await setupTest();

  const older = startStubOlderImpd(ctx.stack, ctx.sendRequest, {
    withoutFeatures: ['databaseCopy'],
  });

  const result = await runCli({
    args: ['db', 'copy', 'before-upgrade', '--json'],
    env: { IMP_URL: older.url, IMP_TOKEN: 'root-token' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr:
      'imp: this impd is older than 0.30.0 and would not know the call; nothing was changed. Upgrade impd, or use an older imp CLI\n',
    code: 1,
  });

  expect(older.calls).toStrictEqual(['system/info']);
});

test('it prints the database copy’s fields in the order a restore script reads them', async () => {
  const ctx = await setupTest();

  const result = await runCli({
    args: ['db', 'copy', 'before-upgrade', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
  });

  const printed: unknown = JSON.parse(result.stdout);

  expect(printed).toStrictEqual({
    path: join(ctx.dataDir, 'db-copies', 'before-upgrade.sqlite'),
    sizeBytes: expect.any(Number) as unknown,
    lastMigration: Object.keys(MIGRATIONS).toSorted().at(-1),
    impVersion: packageJson.version,
    createdAt: expect.any(String) as unknown,
    integrity: 'ok',
  });

  const fields = z.record(z.string(), z.unknown()).parse(printed);

  expect(Object.keys(fields)).toStrictEqual([
    'path',
    'sizeBytes',
    'lastMigration',
    'impVersion',
    'createdAt',
    'integrity',
  ]);
});
