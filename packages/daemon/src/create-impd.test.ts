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
import { createImp, listImps } from './db/imps';
import { openDatabase } from './db/open-database';
import { HOST_ADD_WARNING, HOST_BUILD_WARNING } from './images/image-service';
import { buildSystemDrivePath, buildSystemDrivesDir } from './storage/data-layout';
import { createXfsBackend } from './storage/xfs-backend';
import { buildStubCpuCgroups } from './test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from './test-utils/build-stub-vmm';
import { findFreePorts } from './test-utils/find-free-ports';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'create-impd-'));

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
  const cgroups = buildStubCpuCgroups();
  const logs: string[] = [];

  // a frozen clock, far from the wall clock, that moves only with advance
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

    // the host's free space, so a create never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
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
    advance: (ms: number) => {
      clock.nowMs += ms;
    },
    stack,
  };
}

test('it creates a running imp through the API it serves', async () => {
  const ctx = await setupTest();

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

test('it adopts a running VM through the new runner when it boots again', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  const [before] = await listImps(ctx.db);

  invariant(before?.pid);

  // the first impd still holds its resolver's port in this process
  const restarted = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    { ...ctx.deps, vms: ctx.vmm.startGeneration() },
  );

  ctx.stack.defer(() => restarted.broker.stop());

  ctx.stack.defer(() => {
    restarted.egress.stop();
    restarted.diskUsage.stop();
  });

  const slept = await restarted.imps.sleepImp('dev');

  expect(slept.state).toBe('sleeping');
  expect(ctx.vmm.boots).toHaveLength(1);
  expect(ctx.vmm.stops).toStrictEqual([]);
  expect(ctx.vmm.alive.has(before.pid)).toBeFalse();
});

test('it says CPU limits are kept on a host without a cpu controller', async () => {
  const ctx = await setupTest();

  const restarted = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    {
      ...ctx.deps,
      cgroups: buildStubCpuCgroups({ isEnforced: false }).cgroups,
      vms: ctx.vmm.startGeneration(),
    },
  );

  ctx.stack.defer(() => restarted.broker.stop());

  ctx.stack.defer(() => {
    restarted.egress.stop();
    restarted.diskUsage.stop();
  });

  expect(ctx.logs).toContain(
    'impd: no cpu controller under /sys/fs/cgroup/imps; CPU limits are kept, not applied',
  );
});

test('it says no jailed VM can start on a jailed host without a cpu controller', async () => {
  const ctx = await setupTest();

  const restarted = await createImpd(
    { ...ctx.config, jailerBin: 'jailer', egressDnsPort: findFreePorts(1).take() },
    {
      ...ctx.deps,
      cgroups: buildStubCpuCgroups({ isEnforced: false }).cgroups,
      vms: ctx.vmm.startGeneration(),
    },
  );

  ctx.stack.defer(() => restarted.broker.stop());

  ctx.stack.defer(() => {
    restarted.egress.stop();
    restarted.diskUsage.stop();
  });

  expect(ctx.logs).toContain(
    'impd: no cpu controller under /sys/fs/cgroup/imps; no jailed VM can start (IMP_JAILER=false runs them unjailed, with no limits)',
  );
});

test('it removes a system drive that no imp uses when it boots', async () => {
  const ctx = await setupTest();

  const stale = buildSystemDrivePath(ctx.dataDir, 'e2'.repeat(32));

  await writeFile(stale, 'stale');

  const restarted = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    { ...ctx.deps, vms: ctx.vmm.startGeneration() },
  );

  ctx.stack.defer(() => restarted.broker.stop());

  ctx.stack.defer(() => {
    restarted.egress.stop();
    restarted.diskUsage.stop();
  });

  expect(Bun.file(stale).exists()).resolves.toBeFalse();
});

test('it removes a builder that a stopped impd left when it boots', async () => {
  const ctx = await setupTest();

  const image = await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await createImp(ctx.db, {
    name: 'imp-build-left',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
    kind: 'builder',
  });

  const restarted = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    { ...ctx.deps, vms: ctx.vmm.startGeneration() },
  );

  ctx.stack.defer(() => restarted.broker.stop());

  ctx.stack.defer(() => {
    restarted.egress.stop();
    restarted.diskUsage.stop();
  });

  expect(ctx.logs).toContain('impd: removing builder imp-build-left, which a stopped impd left');
  expect(listImps(ctx.db)).resolves.toStrictEqual([]);
});

test('it drops a move ticket whose stream never came when it boots', async () => {
  const ctx = await setupTest();

  await ctx.db
    .insertInto('move_tickets')
    .values({
      id: 'ticket',
      secret_sha256: 'sha',
      name: 'moved',
      bytes: 1,
      imp_id: null,
      issued_at: 0,
      stream_by: 0,
      stream_used_at: null,
      receipt: null,
      commit_until: null,
      committed_at: null,
      slot: 0,
    })
    .execute();

  const restarted = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    { ...ctx.deps, vms: ctx.vmm.startGeneration() },
  );

  ctx.stack.defer(() => restarted.broker.stop());

  ctx.stack.defer(() => {
    restarted.egress.stop();
    restarted.diskUsage.stop();
  });

  const tickets = await ctx.db.selectFrom('move_tickets').select('id').execute();

  expect(tickets).toStrictEqual([]);
});

test('it ends a lease once its clock passes the lease end', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 30 });

  const held = await ctx.client.leases.list({});

  ctx.advance(30_001);

  const left = await ctx.client.leases.list({});

  expect(held.map((lease) => lease.owner.label)).toStrictEqual(['job']);
  expect(left).toStrictEqual([]);
});

test('it sets a lease end from the wall clock when no clock is given', async () => {
  const ctx = await setupTest();

  const { now: _frozen, ...wallClockDeps } = ctx.deps;

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  const restarted = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    { ...wallClockDeps, vms: ctx.vmm.startGeneration() },
  );

  ctx.stack.defer(() => restarted.broker.stop());

  ctx.stack.defer(() => {
    restarted.egress.stop();
    restarted.diskUsage.stop();
  });

  const startedMs = Date.now();

  const acquired = await restarted.imps.acquireLease(
    'dev',
    { principal: 'root', display: 'root' },
    'job',
    30,
  );

  expect(acquired.lease.until?.getTime()).toBeWithin(startedMs + 30_000, Date.now() + 30_001);
});

test('it logs to stdout when no log is given', async () => {
  const ctx = await setupTest();

  const script = `
    import { loadConfig } from './config';
    import { createImpd } from './create-impd';
    import { openDatabase } from './db/open-database';
    import { createXfsBackend } from './storage/xfs-backend';

    const dataDir = ${JSON.stringify(ctx.dataDir)};

    await createImpd(loadConfig({ IMP_DATA_DIR: dataDir, IMP_BUILD_ISOLATION: 'host' }), {
      db: await openDatabase(':memory:'),
      rootToken: 'root-token',
      storage: createXfsBackend({ dataDir: dataDir + '/child' }),
      systemFiles: { kernelPath: '', systemDrivePath: '', info: ${JSON.stringify({
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: 'b'.repeat(64) },
      })} },

      // the host warnings come before the IPv6 plan; the boot ends there
      resolveIpv6: () => process.exit(0),
    });
  `;

  const child = Bun.spawn(['bun', '-e', script], { cwd: import.meta.dir, stdout: 'pipe' });

  onTestFinished(() => {
    child.kill();
  });

  const stdout = await new Response(child.stdout).text();

  expect(stdout).toStartWith(`${HOST_BUILD_WARNING}\n${HOST_ADD_WARNING}\n`);
});
