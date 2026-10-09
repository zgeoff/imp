import { expect, onTestFinished, test } from 'bun:test';
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
import { createImage } from '../db/images';
import { findImpByName } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { readSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths, buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildMockAgentSession } from '../test-utils/build-mock-agent-session';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubSessionAgent } from '../test-utils/start-stub-session-agent';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'session-service-'));

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

  // the default image, which every create without an image boots
  await Bun.write(join(dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(db, { name: 'base', ref: 'base:latest', digest: 'sha256:base', sizeBytes: 6 });

  const vmm = buildStubVmm();

  const impd = await createImpd(config, {
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
    log: () => {},

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

  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  return { db, dataDir, vmm, impd, client, stack };
}

test('it lists a running imp’s sessions from its agent', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'dev' });

  // an agent from before output offsets
  const main = buildMockAgentSession({
    name: 'main',
    attached: true,
    execution_generation: undefined,
    boot_id: undefined,
    end: undefined,
  });

  const job = buildMockAgentSession({
    name: 'job',
    state: 'exited',
    exit: { code: 137, signal: 9 },
    execution_generation: undefined,
    boot_id: undefined,
    end: undefined,
  });

  await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, [main, job], {
    knowsKill: true,
    stack: ctx.stack,
  });

  const sessions = await ctx.client.sessions.list({ name: 'dev' });

  expect(sessions).toStrictEqual([
    {
      name: 'main',
      pid: main.pid,
      argv: [...main.argv],
      state: 'running',
      attached: true,
      cols: main.cols,
      rows: main.rows,
      startedAt: new Date(main.started_unix_ms),
      continuity: 'none',
    },
    {
      name: 'job',
      pid: job.pid,
      argv: [...job.argv],
      state: 'exited',
      attached: false,
      cols: job.cols,
      rows: job.rows,
      startedAt: new Date(job.started_unix_ms),
      exit: { code: null, signal: 'SIGKILL' },
      continuity: 'none',
    },
  ]);
});

test('it counts no sessions for an imp whose agent impd has not asked yet', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubSessionAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    [buildMockAgentSession()],
    { knowsKill: true, stack: ctx.stack },
  );

  const got = await ctx.client.imps.get({ name: 'dev' });

  expect(got.sessions).toBeUndefined();
});

test('it counts an imp’s sessions on the imp and the host once it lists them', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubSessionAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    [buildMockAgentSession({ name: 'main' }), buildMockAgentSession({ name: 'job' })],
    { knowsKill: true, stack: ctx.stack },
  );

  await ctx.client.sessions.list({ name: 'dev' });

  const got = await ctx.client.imps.get({ name: 'dev' });
  const info = await ctx.client.system.info();

  expect(got.sessions).toBe(2);
  expect(info.sessionCount).toBe(2);
});

test('it records the sessions that the idle loop’s activity read finds', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubSessionAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    [buildMockAgentSession({ name: 'main' })],
    { knowsKill: true, stack: ctx.stack },
  );

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const activity = await ctx.impd.imps.readActivity(record);
  const listed = await ctx.client.imps.list();

  expect(activity?.sessions.map((session) => session.name)).toStrictEqual(['main']);
  expect(listed[0]?.sessions).toBe(1);
});

test('it records a sleeping imp’s sessions as detached in its snapshot', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'dev' });

  const main = buildMockAgentSession({ name: 'main', attached: true });

  await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, [main], {
    knowsKill: true,
    stack: ctx.stack,
  });

  await ctx.client.imps.sleep({ name: 'dev' });

  const meta = readSnapshotMeta(buildImpPaths(ctx.dataDir, imp.id));

  expect(meta?.sessions).toStrictEqual([
    { ...main, attached: false, observed_unix_ms: expect.toBeNumber() },
  ]);
});

test('it lists a sleeping imp’s sessions without a wake', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubSessionAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    [buildMockAgentSession({ name: 'main', attached: true })],
    { knowsKill: true, stack: ctx.stack },
  );

  await ctx.client.imps.sleep({ name: 'dev' });

  const opsBefore = agent.ops.length;

  const sessions = await ctx.client.sessions.list({ name: 'dev' });
  const got = await ctx.client.imps.get({ name: 'dev' });

  expect(sessions.map((session) => [session.name, session.attached])).toStrictEqual([
    ['main', false],
  ]);

  expect(got.state).toBe('sleeping');
  expect(got.sessions).toBe(1);
  expect(ctx.vmm.wakes).toStrictEqual([]);
  expect(agent.ops).toHaveLength(opsBefore);
});

test('it lists no sessions for a stopped imp', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubSessionAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    [buildMockAgentSession({ name: 'main' })],
    { knowsKill: true, stack: ctx.stack },
  );

  await ctx.client.sessions.list({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  const sessions = await ctx.client.sessions.list({ name: 'dev' });
  const got = await ctx.client.imps.get({ name: 'dev' });

  expect(sessions).toStrictEqual([]);
  expect(got.sessions).toBe(0);
});

test('it wakes a sleeping imp for a kill, and ends the session', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubSessionAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    [buildMockAgentSession({ name: 'main' }), buildMockAgentSession({ name: 'other' })],
    { knowsKill: true, stack: ctx.stack },
  );

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.sessions.kill({ name: 'dev', session: 'main' });

  const got = await ctx.client.imps.get({ name: 'dev' });

  expect(ctx.vmm.wakes).toHaveLength(1);
  expect(agent.sessions.map((session) => session.name)).toStrictEqual(['other']);
  expect(got.state).toBe('running');
});

test('it refuses a kill of a session the agent lacks as NOT_FOUND', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, [], {
    knowsKill: true,
    stack: ctx.stack,
  });

  expect(ctx.client.sessions.kill({ name: 'dev', session: 'main' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'session', name: 'main' },
  });
});

test('it refuses a kill on an agent from before sessions as AGENT_OUTDATED', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, [], {
    knowsKill: false,
    stack: ctx.stack,
  });

  expect(ctx.client.sessions.kill({ name: 'dev', session: 'main' })).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
    status: 409,
  });
});

test('it refuses a list of an unknown imp as NOT_FOUND', async () => {
  const ctx = await setupTest();

  expect(ctx.client.sessions.list({ name: 'nope' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'nope' },
  });
});

test('it lists a session’s generation, and its end as last seen, from an agent with offsets', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'dev' });

  const main = buildMockAgentSession({
    name: 'main',
    execution_generation: 'b'.repeat(32),
    boot_id: '22222222-2222-4222-8222-222222222222',
    end: 4096,
  });

  await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, [main], {
    knowsKill: true,
    stack: ctx.stack,
  });

  const before = Date.now();

  const [session] = await ctx.client.sessions.list({ name: 'dev' });

  expect(session).toMatchObject({
    continuity: 'offsets',
    executionGeneration: 'b'.repeat(32),
    bootId: '22222222-2222-4222-8222-222222222222',
    end: 4096,
    endObservedAt: expect.toBeAfter(new Date(before - 1)),
  });
});

test('it keeps a session’s generation and when impd saw its end across a sleep', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'dev' });

  const main = buildMockAgentSession({
    name: 'main',
    execution_generation: 'b'.repeat(32),
    end: 4096,
  });

  await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, [main], {
    knowsKill: true,
    stack: ctx.stack,
  });

  const [seen] = await ctx.client.sessions.list({ name: 'dev' });

  invariant(seen?.endObservedAt);

  const seenBefore = new Date(seen.endObservedAt.getTime() - 1);

  await ctx.client.imps.sleep({ name: 'dev' });

  const [slept] = await ctx.client.sessions.list({ name: 'dev' });

  expect(slept).toMatchObject({
    continuity: 'offsets',
    executionGeneration: 'b'.repeat(32),
    end: 4096,
    endObservedAt: expect.toBeAfter(seenBefore),
  });
});
