import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createImage } from '../db/images';
import { findImpByName, updateImpActivity } from '../db/imps';
import { writeLease } from '../db/leases';
import { openDatabase } from '../db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { createIdleLoop } from './idle-loop';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'idle-leases-'));

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

  // a frozen clock that moves only with advance; impd and the idle loop share it
  const clock = { nowMs: Date.UTC(2026, 0, 1) };

  const impd = await createImpd(config, {
    db,

    // the bearer impd's API takes; these tests call impd's services directly
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

    // the host's free space, so a create never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},
    now: () => clock.nowMs,

    // Firecracker, the kernel and the CPU as this host reports them, which a
    // snapshot must match to load
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
  });

  stack.defer(() => {
    impd.diskUsage.stop();
  });

  return {
    config,
    db,
    dataDir,
    impd,
    now: () => clock.nowMs,
    advance: (ms: number) => {
      clock.nowMs += ms;
    },
  };
}

test('it holds the imp until the end of its earlier lease once the later lease is released', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const imp = await ctx.impd.imps.createImp({ name: 'dev' });

  const at = ctx.now();
  const lease = { impId: imp.id, principal: 'token:a', display: 'a', createdAt: new Date(at) };

  await writeLease(
    ctx.db,
    { ...lease, label: 'early', until: new Date(at + 60_000) },
    { at, reason: 'held' },
  );

  await writeLease(
    ctx.db,
    { ...lease, label: 'late', until: new Date(at + 600_000) },
    { at, reason: 'held' },
  );

  await ctx.impd.imps.releaseLease('dev', { principal: 'token:a', display: 'a' }, 'late');

  const held = await findImpByName(ctx.db, 'dev');

  expect(held?.holdUntil).toStrictEqual(new Date(at + 60_000));
});

test('it keeps an idle imp awake while the earlier of its leases runs', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const imp = await ctx.impd.imps.createImp({ name: 'dev' });

  const at = ctx.now();
  const lease = { impId: imp.id, principal: 'token:a', display: 'a', createdAt: new Date(at) };

  await writeLease(
    ctx.db,
    { ...lease, label: 'early', until: new Date(at + 60_000) },
    { at, reason: 'held' },
  );

  await writeLease(
    ctx.db,
    { ...lease, label: 'late', until: new Date(at + 600_000) },
    { at, reason: 'held' },
  );

  await ctx.impd.imps.releaseLease('dev', { principal: 'token:a', display: 'a' }, 'late');

  // idle long past the timeout: only the lease keeps it awake
  await updateImpActivity(ctx.db, imp.id, new Date(at - 60_000));

  const idle = createIdleLoop({
    config: { ...ctx.config, idleTimeoutS: 1 },
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    now: ctx.now,
    readCpuTicks: () => null,
  });

  await idle.runCheck();

  const checked = await findImpByName(ctx.db, 'dev');

  expect(checked?.state).toBe('running');
});

test('it sleeps an idle imp once the earlier of its leases has ended', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const imp = await ctx.impd.imps.createImp({ name: 'dev' });

  const at = ctx.now();
  const lease = { impId: imp.id, principal: 'token:a', display: 'a', createdAt: new Date(at) };

  await writeLease(
    ctx.db,
    { ...lease, label: 'early', until: new Date(at + 60_000) },
    { at, reason: 'held' },
  );

  await writeLease(
    ctx.db,
    { ...lease, label: 'late', until: new Date(at + 600_000) },
    { at, reason: 'held' },
  );

  await ctx.impd.imps.releaseLease('dev', { principal: 'token:a', display: 'a' }, 'late');

  await updateImpActivity(ctx.db, imp.id, new Date(at - 60_000));

  const idle = createIdleLoop({
    config: { ...ctx.config, idleTimeoutS: 1 },
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    now: ctx.now,
    readCpuTicks: () => null,
  });

  // just past the end of the earlier lease
  ctx.advance(60_000 + 1);

  await idle.runCheck();

  const checked = await findImpByName(ctx.db, 'dev');

  expect(checked?.state).toBe('sleeping');
});
