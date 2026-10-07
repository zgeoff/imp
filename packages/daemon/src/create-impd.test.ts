import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadConfig } from './config';
import { createImpd } from './create-impd';
import type { ImpdDeps } from './create-impd';
import { createImage } from './db/images';
import { listImps } from './db/imps';
import { openDatabase } from './db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from './storage/data-layout';
import { createXfsBackend } from './storage/xfs-backend';
import { buildStubCpuCgroups } from './test-utils/build-stub-cpu-cgroups';
import { buildFakeVmm } from './test-utils/build-stub-vmm';
import { findFreePorts } from './test-utils/find-free-ports';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dataDir = await mkdtemp(join(tmpdir(), 'create-impd-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the resolver binds this on every address, so each test takes a free one
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

  const vmm = buildFakeVmm();
  const cgroups = buildStubCpuCgroups();
  const logs: string[] = [];

  const deps: ImpdDeps = {
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
    log: (message) => {
      logs.push(message);
    },
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
    cgroups: cgroups.cgroups,
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
  };

  const impd = await createImpd(config, deps);

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: { authorization: 'Bearer root-token' },
    fetch: (request) => impd.api.app.handle(request),
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(link);
  const owned = stack.move();

  return {
    config,
    db,
    dataDir,
    deps,
    vmm,
    cgroups,
    logs,
    impd,
    client,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it serves the API over the services it boots', async () => {
  await using ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const created = await ctx.client.imps.create({ name: 'dev' });

  expect(created).toMatchObject({ name: 'dev', state: 'running' });
});

test('it re-adopts a running VM when it boots again over the same database', async () => {
  await using ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  const [before] = await listImps(ctx.db);

  // the first impd still holds its resolver's port in this process
  const restartConfig = { ...ctx.config, egressDnsPort: findFreePorts(1).take() };

  const restarted = await createImpd(restartConfig, {
    ...ctx.deps,
    vms: ctx.vmm.startGeneration(),
  });

  onTestFinished(async () => {
    restarted.egress.stop();
    restarted.diskUsage.stop();

    await restarted.broker.stop();
  });

  const [after] = await listImps(ctx.db);

  invariant(before);

  expect(after).toMatchObject({ state: 'running', pid: before.pid });
});

test('it says CPU limits are kept on a host without a cpu controller', async () => {
  await using ctx = await setupTest();

  // the first impd still holds its resolver's port in this process
  const restartConfig = { ...ctx.config, egressDnsPort: findFreePorts(1).take() };

  const restarted = await createImpd(restartConfig, {
    ...ctx.deps,
    cgroups: buildStubCpuCgroups({ isEnforced: false }).cgroups,
    vms: ctx.vmm.startGeneration(),
  });

  onTestFinished(async () => {
    restarted.egress.stop();
    restarted.diskUsage.stop();

    await restarted.broker.stop();
  });

  expect(ctx.logs).toContain(
    'impd: no cpu controller under /sys/fs/cgroup/imps; CPU limits are kept, not applied',
  );
});

test('it removes a system drive that no imp uses when it boots', async () => {
  await using ctx = await setupTest();

  const stale = buildSystemDrivePath(ctx.dataDir, 'e2'.repeat(32));

  await writeFile(stale, 'stale');

  // the first impd still holds its resolver's port in this process
  const restartConfig = { ...ctx.config, egressDnsPort: findFreePorts(1).take() };

  const restarted = await createImpd(restartConfig, {
    ...ctx.deps,
    vms: ctx.vmm.startGeneration(),
  });

  onTestFinished(async () => {
    restarted.egress.stop();
    restarted.diskUsage.stop();

    await restarted.broker.stop();
  });

  expect(Bun.file(stale).exists()).resolves.toBeFalse();
});
