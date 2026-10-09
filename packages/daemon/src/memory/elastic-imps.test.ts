import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { createImage } from '../db/images';
import { openDatabase } from '../db/open-database';
import { readSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths, buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { buildMemoryMax, createCpuCgroups } from '../vmm/cpu-cgroups';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'elastic-imps-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one
  const config = {
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    }),

    // a new disk stays the size of its image, so a fork copies a few bytes
    defaultDiskBytes: 0,
  };

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
  const cgroups = buildStubCpuCgroups();
  const logs: string[] = [];

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

      // the host grows a new disk's filesystem, so no guest boot has to
      growFilesystem: () => Promise.resolve(true),
      hostCpus: 8,
    },
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  };

  const impd = await createImpd(config, deps);

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
  });

  stack.defer(() => {
    impd.diskUsage.stop();
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  return { config, deps, db, dataDir, vmm, cgroups, logs, impd, client, stack };
}

test('it refuses a max above 4 × the memory at create', async () => {
  const ctx = await setupTest();

  const creating = ctx.client.imps.create({ name: 'big', memoryMib: 256, maxMemoryMib: 1025 });

  expect(creating).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(creating).rejects.toThrow('more than 4 × the memory (1024 MiB)');
});

test('it refuses a max below the memory at create', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.imps.create({ name: 'small', memoryMib: 512, maxMemoryMib: 256 }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it creates an imp with a max of 4 × its memory', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  expect(created).toMatchObject({ memoryMib: 256, maxMemoryMib: 1024 });
});

test('it creates an imp with no max when the create asks for none', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'plain', memoryMib: 256 });

  expect(created).not.toHaveProperty('maxMemoryMib');
});

test('it forks an imp with the max of its source', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const fork = await ctx.client.imps.fork({ source: 'dev', name: 'twin' });

  expect(fork).toMatchObject({ memoryMib: 256, maxMemoryMib: 1024 });
});

test('it never boots an imp whose max is larger than the whole RAM budget', async () => {
  const ctx = await setupTest();

  // an impd with a budget the imp's memory fits but its max does not
  const impd = await createImpd(
    { ...ctx.config, ramBudgetMib: 1024, egressDnsPort: findFreePorts(1).take() },
    { ...ctx.deps, vms: ctx.vmm.startGeneration() },
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
  });

  ctx.stack.defer(() => {
    impd.diskUsage.stop();
  });

  const creating = impd.imps.createImp({ name: 'big', memoryMib: 512, maxMemoryMib: 2048 });

  expect(creating).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
  expect(creating).rejects.toThrow('at its max (2048 MiB)');
});

test('it unplugs on a sleep what the guest can spare', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  // 512 plugged, 100 used: the target is 228, but the guest stops at 256
  ctx.vmm.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 512,
    requestedMib: 512,
    usedMib: 100,
    unplugFloorMib: 256,
  });

  await ctx.client.imps.sleep({ name: 'dev' });

  expect(readSnapshotMeta(paths)).toMatchObject({ memoryMib: 256, pluggedMib: 256 });
  expect(ctx.vmm.guestMemory.get(paths.dir)?.requestedMib).toBe(256);
  expect(ctx.logs).toSatisfyAny((line: string) => line.includes('256 MiB plugged'));
});

test('it allows on a wake what the guest kept plugged at its sleep', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.vmm.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 512,
    requestedMib: 512,
    usedMib: 100,
    unplugFloorMib: 256,
  });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  // the boot's limit, then the wake's, before the load
  expect(
    ctx.cgroups.calls.filter((call) => call.startsWith(`memory ${created.id} `)),
  ).toStrictEqual([`memory ${created.id} 256`, `memory ${created.id} 512`]);
});

test('it records what a plug under way asked for at a sleep', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  // 256 plugged of 512 asked, and nothing to spare
  ctx.vmm.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 256,
    requestedMib: 512,
    usedMib: 400,
    unplugFloorMib: 0,
  });

  await ctx.client.imps.sleep({ name: 'dev' });

  expect(readSnapshotMeta(paths)).toMatchObject({ pluggedMib: 512 });
});

test('it allows on a wake what a plug under way at the sleep asked for', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.vmm.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 256,
    requestedMib: 512,
    usedMib: 400,
    unplugFloorMib: 0,
  });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  expect(ctx.cgroups.calls.findLast((call) => call.startsWith(`memory ${created.id} `))).toBe(
    `memory ${created.id} 768`,
  );
});

test('it sleeps an imp that does not grow without asking its guest', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'plain', memoryMib: 256 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  await ctx.client.imps.sleep({ name: 'plain' });

  const meta = readSnapshotMeta(paths);

  invariant(meta);

  expect(ctx.vmm.guestMemory.has(paths.dir)).toBeFalse();
  expect(meta).not.toHaveProperty('pluggedMib');
});

test('it raises memory.max with a grow of the guest', async () => {
  const ctx = await setupTest();

  // a cgroup root with the cpu and memory controllers handed to imps/, as
  // setup-cgroups.sh leaves it; it goes after the impd that writes it
  const root = await mkdtemp(join(tmpdir(), 'imp-elastic-cgroups-'));

  ctx.stack.defer(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, 'imps'));
  await writeFile(join(root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const impd = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    {
      ...ctx.deps,
      cgroups: createCpuCgroups({ root, log: () => {} }),
      vms: ctx.vmm.startGeneration(),
    },
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
  });

  ctx.stack.defer(() => {
    impd.diskUsage.stop();
  });

  // an agent that moves its container's limit with the guest
  ctx.vmm.agent.version = '0.17.0';

  const created = await impd.imps.createImp({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  // 56 MiB available, under the 128 MiB mark: the next tick plugs a step
  ctx.vmm.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 0,
    requestedMib: 0,
    usedMib: 200,
    unplugFloorMib: 0,
  });

  await impd.governed.memory.runTick();

  expect(ctx.vmm.guestMemory.get(paths.dir)?.pluggedMib).toBe(256);

  const memoryMax = await readFile(join(root, 'imps', created.id, 'memory.max'), 'utf8');

  expect(memoryMax).toBe(buildMemoryMax(512));
});

test('it keeps memory.max at the plugged size across a sleep and a wake', async () => {
  const ctx = await setupTest();
  const root = await mkdtemp(join(tmpdir(), 'imp-elastic-cgroups-'));

  ctx.stack.defer(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, 'imps'));
  await writeFile(join(root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const impd = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    {
      ...ctx.deps,
      cgroups: createCpuCgroups({ root, log: () => {} }),
      vms: ctx.vmm.startGeneration(),
    },
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
  });

  ctx.stack.defer(() => {
    impd.diskUsage.stop();
  });

  ctx.vmm.agent.version = '0.17.0';

  const created = await impd.imps.createImp({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.vmm.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 0,
    requestedMib: 0,
    usedMib: 200,
    unplugFloorMib: 0,
  });

  await impd.governed.memory.runTick();

  // the guest has nothing to spare, so it sleeps with the step plugged
  await impd.imps.sleepImp('dev');
  await impd.imps.wakeImp('dev');

  const memoryMax = await readFile(join(root, 'imps', created.id, 'memory.max'), 'utf8');

  expect(memoryMax).toBe(buildMemoryMax(512));
});

test('it sets memory.max back to the memory on a cold boot after a stop', async () => {
  const ctx = await setupTest();
  const root = await mkdtemp(join(tmpdir(), 'imp-elastic-cgroups-'));

  ctx.stack.defer(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, 'imps'));
  await writeFile(join(root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const impd = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    {
      ...ctx.deps,
      cgroups: createCpuCgroups({ root, log: () => {} }),
      vms: ctx.vmm.startGeneration(),
    },
  );

  ctx.stack.defer(() => impd.broker.stop());

  ctx.stack.defer(() => {
    impd.egress.stop();
  });

  ctx.stack.defer(() => {
    impd.diskUsage.stop();
  });

  ctx.vmm.agent.version = '0.17.0';

  const created = await impd.imps.createImp({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.vmm.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 0,
    requestedMib: 0,
    usedMib: 200,
    unplugFloorMib: 0,
  });

  await impd.governed.memory.runTick();
  await impd.imps.stopImp('dev');
  await impd.imps.startImp('dev');

  const memoryMax = await readFile(join(root, 'imps', created.id, 'memory.max'), 'utf8');

  expect(memoryMax).toBe(buildMemoryMax(256));
});

test('it allows on adopt after a restart what the guest holds', async () => {
  const ctx = await setupTest();
  const root = await mkdtemp(join(tmpdir(), 'imp-elastic-cgroups-'));

  ctx.stack.defer(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, 'imps'));
  await writeFile(join(root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const created = await ctx.impd.imps.createImp({
    name: 'dev',
    memoryMib: 256,
    maxMemoryMib: 1024,
  });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  // 512 plugged, none of it free to unplug
  ctx.vmm.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 512,
    requestedMib: 512,
    usedMib: 700,
    unplugFloorMib: 512,
  });

  // a new impd, whose cgroup writer knows nothing of the sizes set before
  const restarted = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    {
      ...ctx.deps,
      cgroups: createCpuCgroups({ root, log: () => {} }),
      vms: ctx.vmm.startGeneration(),
    },
  );

  ctx.stack.defer(() => restarted.broker.stop());

  ctx.stack.defer(() => {
    restarted.egress.stop();
  });

  ctx.stack.defer(() => {
    restarted.diskUsage.stop();
  });

  const memoryMax = await readFile(join(root, 'imps', created.id, 'memory.max'), 'utf8');

  expect(memoryMax).toBe(buildMemoryMax(768));
});

test('it keeps the adopted memory.max through a sleep before any tick after a restart', async () => {
  const ctx = await setupTest();
  const root = await mkdtemp(join(tmpdir(), 'imp-elastic-cgroups-'));

  ctx.stack.defer(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, 'imps'));
  await writeFile(join(root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const created = await ctx.impd.imps.createImp({
    name: 'dev',
    memoryMib: 256,
    maxMemoryMib: 1024,
  });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.vmm.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 512,
    requestedMib: 512,
    usedMib: 700,
    unplugFloorMib: 512,
  });

  const restarted = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    {
      ...ctx.deps,
      cgroups: createCpuCgroups({ root, log: () => {} }),
      vms: ctx.vmm.startGeneration(),
    },
  );

  ctx.stack.defer(() => restarted.broker.stop());

  ctx.stack.defer(() => {
    restarted.egress.stop();
  });

  ctx.stack.defer(() => {
    restarted.diskUsage.stop();
  });

  await restarted.imps.sleepImp('dev');

  const memoryMax = await readFile(join(root, 'imps', created.id, 'memory.max'), 'utf8');

  expect(memoryMax).toBe(buildMemoryMax(768));
  expect(readSnapshotMeta(paths)).toMatchObject({ pluggedMib: 512 });
});

test('it never grows an elastic imp whose agent predates elastic memory, and logs why', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.vmm.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 0,
    requestedMib: 0,
    usedMib: 200,
    unplugFloorMib: 0,
  });

  await ctx.impd.governed.memory.runTick();

  expect(ctx.vmm.guestMemory.get(paths.dir)?.pluggedMib).toBe(0);

  expect(ctx.logs).toSatisfyAny((line: string) =>
    /dev: memory low, not grown.*the imp's agent has no elastic memory/.test(line),
  );
});
