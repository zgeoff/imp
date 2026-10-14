import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createImage } from '../db/images';
import { openDatabase } from '../db/open-database';
import {
  buildImagePaths,
  buildImpPaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildMockNewImage } from '../test-utils/build-mock-new-image';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubFilesAgent } from '../test-utils/start-stub-files-agent';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'file-api-'));

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

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  // the default image, which every create without an image boots
  await Bun.write(buildImagePaths(dataDir, image.digest).rootfs, 'rootfs');

  await createImage(db, image);

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

  return { dataDir, vmm, impd, client, stack };
}

test('it writes a file through the agent and answers its guest path', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.vmm.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  const written = await ctx.client.files.write({
    name: 'dev',
    path: 'notes/today.json',
    content: '{"title":"kettle"}',
  });

  expect(written).toStrictEqual({ path: '/run/imp/files/notes/today.json' });
  expect([...agent.files]).toStrictEqual([['notes/today.json', '{"title":"kettle"}']]);
});

test('it removes a file through the agent and reports that it was there', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.vmm.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  agent.files.set('notes/today.json', '{}');

  const removed = await ctx.client.files.remove({ name: 'dev', path: 'notes/today.json' });

  expect(removed).toStrictEqual({ removed: true });
  expect(agent.files.size).toBe(0);
});

test('it reports a remove of a missing file as not removed', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.vmm.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  const removed = await ctx.client.files.remove({ name: 'dev', path: 'notes/today.json' });

  expect(removed).toStrictEqual({ removed: false });
});

test('it refuses a path outside the rule before it reaches the agent', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.vmm.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  expect(
    ctx.client.files.write({ name: 'dev', path: '../etc/passwd', content: 'x' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

  expect(agent.requests).toStrictEqual([]);
});

test('it refuses a write to a full tree as BAD_REQUEST with the agent’s reason', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.vmm.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  agent.full.isFull = true;

  expect(
    ctx.client.files.write({ name: 'dev', path: 'notes/today.json', content: '{}' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'the read-only files are full' });
});

test('it refuses a write on an agent from before the read-only files as AGENT_OUTDATED', async () => {
  const ctx = await setupTest();

  // each boot and wake reports it
  ctx.vmm.agent.version = '0.18.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: false,
    stack: ctx.stack,
  });

  expect(
    ctx.client.files.write({ name: 'dev', path: 'notes/today.json', content: '{}' }),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });

  expect(agent.requests).toStrictEqual([]);
});

test('it lets an exec-scope token write a file', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.vmm.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  const token = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  const exec: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${token.secret}` },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  await exec.files.write({ name: 'dev', path: 'notes/today.json', content: '{}' });

  expect([...agent.files.keys()]).toStrictEqual(['notes/today.json']);
});

test('it refuses a read-scope token’s write as FORBIDDEN', async () => {
  const ctx = await setupTest();

  // an agent with the read-only files, which each boot and wake reports
  ctx.vmm.agent.version = '0.19.0';

  const imp = await ctx.client.imps.create({ name: 'dev' });

  const agent = await startStubFilesAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    knowsFiles: true,
    stack: ctx.stack,
  });

  const token = await ctx.client.tokens.create({ name: 'viewer', scope: 'read' });

  const read: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${token.secret}` },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  expect(
    read.files.write({ name: 'dev', path: 'notes/today.json', content: '{}' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });

  expect(agent.requests).toStrictEqual([]);
});
