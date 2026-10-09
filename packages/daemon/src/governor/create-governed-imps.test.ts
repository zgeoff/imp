import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import type { ImpdDeps } from '../create-impd';
import { createImage } from '../db/images';
import { listImps } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'governed-imps-'));

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

  // a frozen clock that moves only with advance, so imps differ in activity
  const clock = { nowMs: Date.UTC(2026, 0, 1) };

  const deps: ImpdDeps = {
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
      // what the governor counts for each live VM
      readRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
      readRssMib: (pid) => (vmm.alive.has(pid) ? 340 : null),
      growFilesystem: () => Promise.resolve(false),
      hostCpus: 8,
    },
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  };

  return {
    config,
    deps,
    db,
    dataDir,
    vmm,
    stack,
    advance: (ms: number) => {
      clock.nowMs += ms;
    },
  };
}

test('it skips a victim whose lock another boot holds instead of waiting for it', async () => {
  const ctx = await setupTest();

  // two awake imps of 300 MiB; making room for 600 MiB needs both asleep
  const impd = await createImpd(
    { ...ctx.config, ramBudgetMib: 800, defaultMemoryMib: 512 },
    ctx.deps,
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
  });

  ctx.stack.defer(() => {
    impd.diskUsage.stop();
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await impd.imps.createImp({ name: 'a' });

  ctx.advance(1000);

  await impd.imps.createImp({ name: 'b' });

  const gate = ctx.vmm.hold('sleep');

  // the governor holds admission while it sleeps `a`
  const admitting = impd.governor.admit({ id: 'x', name: 'x', reserveMib: 600, memoryMib: 600 });

  await gate.reached;

  // a restore of `b`: it takes b's lock, halts it and boots it, which asks
  // the governor for admission
  const restoring = impd.imps.lockImp('b', async (imp) => {
    const halted = await impd.imps.haltImp(imp);

    return impd.imps.bootImp(halted);
  });

  await waitFor(() => {
    expect(ctx.vmm.stops).toHaveLength(1);
  });

  gate.release();

  const [admitted, restored] = await Promise.allSettled([admitting, restoring]);

  expect(admitted.status).toBe('fulfilled');

  // the admission took the room the restore's boot asks for
  expect(restored).toMatchObject({ status: 'rejected', reason: { code: 'RAM_BUDGET_EXCEEDED' } });
});

test('it stops sleeping imps for a rejected admit once a sleep fails', async () => {
  const ctx = await setupTest();

  // 900 MiB awake + 900 reserved: 800 missing, so the pick is a, b and c
  const impd = await createImpd(
    { ...ctx.config, ramBudgetMib: 1000, defaultMemoryMib: 512 },
    ctx.deps,
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
  });

  ctx.stack.defer(() => {
    impd.diskUsage.stop();
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  // awake imps, from the least recently active
  await impd.imps.createImp({ name: 'a' });

  ctx.advance(1000);

  await impd.imps.createImp({ name: 'b' });

  ctx.advance(1000);

  await impd.imps.createImp({ name: 'c' });

  ctx.vmm.queue('sleep', 'ok', 'fail');

  expect(
    impd.governor.admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 }),
  ).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  // 500 MiB still missing and only c left: c is not slept for nothing
  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => [imp.name, imp.state])).toStrictEqual([
    ['a', 'sleeping'],
    ['b', 'running'],
    ['c', 'running'],
  ]);

  expect(ctx.vmm.alive.size).toBe(2);
});

test('it stops sleeping imps for a rejected admit once the lock of a victim is taken', async () => {
  const ctx = await setupTest();

  // 900 MiB awake + 900 reserved: 800 missing, so the pick is a, b and c
  const impd = await createImpd(
    { ...ctx.config, ramBudgetMib: 1000, defaultMemoryMib: 512 },
    ctx.deps,
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
  });

  ctx.stack.defer(() => {
    impd.diskUsage.stop();
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await impd.imps.createImp({ name: 'a' });

  ctx.advance(1000);

  await impd.imps.createImp({ name: 'b' });

  ctx.advance(1000);

  await impd.imps.createImp({ name: 'c' });

  // b's lock is taken while a sleeps, after the pick of a, b and c, and stays
  // taken until the admit is done
  const sleeping = ctx.vmm.hold('sleep');
  const admitting = impd.governor.admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 });

  await sleeping.reached;

  const locked = Promise.withResolvers<void>();
  const unlock = Promise.withResolvers<void>();

  onTestFinished(() => {
    unlock.resolve();
  });

  const locking = impd.imps.lockImp('b', () => {
    locked.resolve();

    return unlock.promise;
  });

  await locked.promise;

  sleeping.release();

  expect(admitting).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  unlock.resolve();

  await locking;

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => [imp.name, imp.state])).toStrictEqual([
    ['a', 'sleeping'],
    ['b', 'running'],
    ['c', 'running'],
  ]);

  expect(ctx.vmm.alive.size).toBe(2);
});

test('it picks again past a failed sleep and fits an admit when the rest is enough', async () => {
  const ctx = await setupTest();

  // 1200 MiB awake + 900 reserved: 800 missing; without b, c and d cover it
  const impd = await createImpd(
    { ...ctx.config, ramBudgetMib: 1300, defaultMemoryMib: 512 },
    ctx.deps,
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
  });

  ctx.stack.defer(() => {
    impd.diskUsage.stop();
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await impd.imps.createImp({ name: 'a' });

  ctx.advance(1000);

  await impd.imps.createImp({ name: 'b' });

  ctx.advance(1000);

  await impd.imps.createImp({ name: 'c' });

  ctx.advance(1000);

  await impd.imps.createImp({ name: 'd' });

  ctx.vmm.queue('sleep', 'ok', 'fail');

  await impd.governor.admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 });

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => [imp.name, imp.state])).toStrictEqual([
    ['a', 'sleeping'],
    ['b', 'running'],
    ['c', 'sleeping'],
    ['d', 'sleeping'],
  ]);
});
