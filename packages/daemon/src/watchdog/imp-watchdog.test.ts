import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import type { ImpdDeps } from '../create-impd';
import { listColdBoots } from '../db/cold-boots';
import { createImage } from '../db/images';
import { findImpByName } from '../db/imps';
import { openDatabase } from '../db/open-database';
import {
  buildImpPaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
  buildWatchdogSlot,
} from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'imp-watchdog-'));

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

  // the image every imp boots from: a create needs one
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const vmm = buildStubVmm();
  const logs: string[] = [];

  // the host's free space as the disk budget reads it; a test lowers it
  const disk = { usedBytes: 0, availableBytes: 1024 ** 4 };

  // a frozen clock that moves only with advance, past the watchdog's timeout
  const clock = { nowMs: Date.UTC(2026, 0, 1) };

  const deps: ImpdDeps = {
    db,

    // the bearer the test's client sends
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
    readDiskSpace: () => Promise.resolve({ ...disk }),
    log: (message) => {
      logs.push(message);
    },
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
      growFilesystem: () => Promise.resolve(true),
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
    logs,
    disk,
    stack,
    advance: (ms: number) => {
      clock.nowMs += ms;
    },
  };
}

test('it marks since when the agent is silent and keeps the imp running under report', async () => {
  const ctx = await setupTest();

  const impd = await createImpd(
    { ...ctx.config, watchdogAction: 'report', watchdogTimeoutS: 10 },
    ctx.deps,
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  await client.imps.create({ name: 'dev' });

  const created = await findImpByName(ctx.db, 'dev');

  invariant(created?.pid);

  // the idle loop's two looks, 11 s apart, and the confirming ping fails
  impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.vmm.queue('agentReady', 'fail', 'fail');
  impd.imps.watchdog.observe(created, false);

  await impd.imps.watchdog.settle();

  const imp = await client.imps.get({ name: 'dev' });

  expect(imp.state).toBe('running');
  expect(imp.agentSilentSince).toBeInstanceOf(Date);
  expect(ctx.vmm.alive.has(created.pid)).toBeTrue();
});

test('it kills the VM and boots the imp cold under restart, saying why', async () => {
  const ctx = await setupTest();

  const impd = await createImpd(
    { ...ctx.config, watchdogAction: 'restart', watchdogTimeoutS: 10 },
    ctx.deps,
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  await client.imps.create({ name: 'dev' });

  const created = await findImpByName(ctx.db, 'dev');

  invariant(created?.pid);

  // the confirming ping fails, and so does the look under the lock
  impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.vmm.queue('agentReady', 'fail', 'fail');
  impd.imps.watchdog.observe(created, false);

  await impd.imps.watchdog.settle();

  const imp = await client.imps.get({ name: 'dev' });

  expect(ctx.vmm.alive.has(created.pid)).toBeFalse();
  expect(ctx.vmm.stops).toStrictEqual([{ pid: created.pid, graceful: false }]);
  expect(imp.state).toBe('running');
  expect(imp.coldBootReason).toBe('the watchdog restarted it: its agent stopped answering');
  expect(imp).not.toHaveProperty('agentSilentSince');
});

test('it records a watchdog restart as the cause of a cold boot', async () => {
  const ctx = await setupTest();

  const impd = await createImpd(
    { ...ctx.config, watchdogAction: 'restart', watchdogTimeoutS: 10 },
    ctx.deps,
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  await impd.imps.createImp({ name: 'dev' });

  const created = await findImpByName(ctx.db, 'dev');

  invariant(created);

  impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.vmm.queue('agentReady', 'fail', 'fail');
  impd.imps.watchdog.observe(created, false);

  await impd.imps.watchdog.settle();

  // the restart ended every session generation: a client learns why
  const boots = await listColdBoots(ctx.db, created.id);

  expect(boots.map((boot) => boot.cause)).toStrictEqual(['watchdog', 'start']);
});

test('it writes the memory to the owner-only watchdog slot under snapshot, then boots cold', async () => {
  const ctx = await setupTest();

  const impd = await createImpd(
    { ...ctx.config, watchdogAction: 'snapshot', watchdogTimeoutS: 10 },
    ctx.deps,
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  await impd.imps.createImp({ name: 'dev' });

  const created = await findImpByName(ctx.db, 'dev');

  invariant(created?.pid);

  impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.vmm.queue('agentReady', 'fail', 'fail');
  impd.imps.watchdog.observe(created, false);

  await impd.imps.watchdog.settle();

  const slot = buildWatchdogSlot(buildImpPaths(ctx.dataDir, created.id).dir);

  const imp = await findImpByName(ctx.db, 'dev');

  expect(statSync(slot.snapshotDir).mode & 0o777).toBe(0o700);
  expect(statSync(slot.memFile).mode & 0o777).toBe(0o600);
  expect(statSync(slot.snapshotMeta).mode & 0o777).toBe(0o600);
  expect(imp?.state).toBe('running');
  expect(ctx.vmm.alive.has(created.pid)).toBeFalse();
});

test('it removes the watchdog slot with a destroyed imp', async () => {
  const ctx = await setupTest();

  const impd = await createImpd(
    { ...ctx.config, watchdogAction: 'snapshot', watchdogTimeoutS: 10 },
    ctx.deps,
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  await impd.imps.createImp({ name: 'dev' });

  const created = await findImpByName(ctx.db, 'dev');

  invariant(created);

  impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.vmm.queue('agentReady', 'fail', 'fail');
  impd.imps.watchdog.observe(created, false);

  await impd.imps.watchdog.settle();
  await impd.imps.destroyImp('dev');

  const slot = buildWatchdogSlot(buildImpPaths(ctx.dataDir, created.id).dir);

  expect(existsSync(slot.snapshotDir)).toBeFalse();
});

test('it boots the imp cold with no slot under snapshot when the disk has no room', async () => {
  const ctx = await setupTest();

  const impd = await createImpd(
    { ...ctx.config, watchdogAction: 'snapshot', watchdogTimeoutS: 10 },
    ctx.deps,
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  await impd.imps.createImp({ name: 'dev' });

  const created = await findImpByName(ctx.db, 'dev');

  invariant(created?.pid);

  // below the 5 GiB reserve
  ctx.disk.availableBytes = 4 * 1024 ** 3;

  impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.vmm.queue('agentReady', 'fail', 'fail');
  impd.imps.watchdog.observe(created, false);

  await impd.imps.watchdog.settle();

  const imp = await findImpByName(ctx.db, 'dev');

  const slot = buildWatchdogSlot(buildImpPaths(ctx.dataDir, created.id).dir);

  expect(existsSync(slot.snapshotDir)).toBeFalse();
  expect(imp?.state).toBe('running');
  expect(ctx.vmm.alive.has(created.pid)).toBeFalse();
});

test('it keeps the VM under restart when the agent answers again under the lock', async () => {
  const ctx = await setupTest();

  const impd = await createImpd(
    { ...ctx.config, watchdogAction: 'restart', watchdogTimeoutS: 10 },
    ctx.deps,
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  await impd.imps.createImp({ name: 'dev' });

  const created = await findImpByName(ctx.db, 'dev');

  invariant(created?.pid);

  // the confirming ping fails; the look under the lock gets an answer
  impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.vmm.queue('agentReady', 'fail', 'ok');
  impd.imps.watchdog.observe(created, false);

  await impd.imps.watchdog.settle();

  const boots = await listColdBoots(ctx.db, created.id);

  expect(ctx.vmm.alive.has(created.pid)).toBeTrue();
  expect(boots.map((boot) => boot.cause)).toStrictEqual(['start']);
  expect(ctx.logs).toSatisfyAny((line: string) => line.includes('the watchdog stands down'));
});

test('it leaves alone under restart a VM that a sleep and a wake replaced during the ping', async () => {
  const ctx = await setupTest();

  const impd = await createImpd(
    { ...ctx.config, watchdogAction: 'restart', watchdogTimeoutS: 10 },
    ctx.deps,
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  await impd.imps.createImp({ name: 'dev' });

  const created = await findImpByName(ctx.db, 'dev');

  invariant(created?.pid);

  // the watchdog saw an older pid than the record holds now
  const seen = { ...created, pid: created.pid + 1000 };

  impd.imps.watchdog.observe(seen, false);
  ctx.advance(11_000);
  ctx.vmm.queue('agentReady', 'fail', 'fail');
  impd.imps.watchdog.observe(seen, false);

  await impd.imps.watchdog.settle();

  const boots = await listColdBoots(ctx.db, created.id);

  expect(ctx.vmm.alive.has(created.pid)).toBeTrue();
  expect(boots.map((boot) => boot.cause)).toStrictEqual(['start']);
});
