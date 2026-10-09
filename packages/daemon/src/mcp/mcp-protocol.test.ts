import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImpGuard, createMcpServer } from '@imp/mcp';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '@zgeoff/imp-client';
import * as z from 'zod';
import { buildStubRepeat } from '../../../mcp/src/test-utils/build-stub-repeat';
import { buildApiListenOptions } from '../api-listen-options';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createImage } from '../db/images';
import { findImpByName } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { buildImpPaths, buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubExecGuest } from '../test-utils/build-stub-exec-guest';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubExecAgent } from '../test-utils/start-stub-exec-agent';

// impd's real app on a loopback port for an exec's socket, a root client,
// `stack`, whose releases run before impd stops, and an MCP server whose
// messages land parsed in `sent`, its progress stepped by `repeat`
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'mcp-protocol-'));

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

    // a new disk stays the size of its image, since the plain-copy clone of
    // a fork or a checkpoint copies every byte
    defaultDiskBytes: 0,
  };

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

    // the host's free space, so a create never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},

    // a frozen clock, so a later read of an imp matches the answer about it
    now: () => Date.UTC(2026, 0, 1),

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

  // as main.ts listens, on a free loopback port
  const server = impd.api.app.listen({
    ...buildApiListenOptions(config),
    port: 0,
    hostname: '127.0.0.1',
  });

  stack.defer(async () => {
    await server.stop(true);
  });

  // the image every imps.create boots when it names none
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const url = `http://127.0.0.1:${String(server.server?.port)}`;
  const repeat = buildStubRepeat();

  // a short kill grace, so a stopped command's SIGKILL comes soon; progress
  // ticks only when the test steps `repeat` by 1000 ms
  const mcp = createMcpServer({
    version: '1.2.3',
    killGraceMs: 50,
    progressIntervalMs: 1000,
    repeat: repeat.repeat,
  });

  // its calls in flight end before impd's app closes
  stack.defer(() => mcp.close());

  const sent: unknown[] = [];

  return {
    db,
    dataDir,
    stack,
    url,
    rootClient: createImpClient({ url, token: 'root-token' }),
    mcp,
    repeat,
    sent,
    reply: (message: string) => {
      sent.push(JSON.parse(message));
    },
  };
}

test('it still answers a cancelled create, so the agent learns the name of what it made', async () => {
  const ctx = await setupTest();

  const context = {
    reply: ctx.reply,
    client: createImpClient({ url: ctx.url, token: 'root-token' }),
    guard: createImpGuard({ prefix: 'agent-' }),
    scope: 'manage' as const,
  };

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: {} },
    }),
    context,
  );

  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    context,
  );

  await call;

  const [made] = await ctx.rootClient.imps.list();

  invariant(made);

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(made));
  const stored = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  expect(made.name).toStartWith('agent-');

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          imp: {
            ...stored,

            // its awake time runs on the wall clock between the answer and the read
            resources: { ...stored.resources, awakeMs: expect.any(Number) as unknown },
          },
        },
        isError: false,
      },
    },
  ]);
});

test('it still answers a cancelled fork, so the agent learns the name of what it made', async () => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'agent-src' });

  const context = {
    reply: ctx.reply,
    client: createImpClient({ url: ctx.url, token: 'root-token' }),
    guard: createImpGuard({ prefix: 'agent-' }),
    scope: 'manage' as const,
  };

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'agent-src' } },
    }),
    context,
  );

  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    context,
  );

  await call;

  const listed = await ctx.rootClient.imps.list();

  const fork = listed.find((imp) => imp.name !== 'agent-src');

  invariant(fork);

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(fork));
  const stored = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  expect(fork.name).toStartWith('agent-');

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          imp: {
            ...stored,

            // its awake time runs on the wall clock between the answer and the read
            resources: { ...stored.resources, awakeMs: expect.any(Number) as unknown },
          },
          grantsNotCopied: [],
        },
        isError: false,
      },
    },
  ]);
});

test('it still answers a cancelled restore, so the agent learns the state of the imp', async () => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'agent-src' });
  await ctx.rootClient.checkpoints.create({ name: 'agent-src', label: 'cp' });

  const context = {
    reply: ctx.reply,
    client: createImpClient({ url: ctx.url, token: 'root-token' }),
    guard: createImpGuard({ prefix: 'agent-' }),
    scope: 'manage' as const,
  };

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_restore', arguments: { name: 'agent-src', checkpoint: 'cp' } },
    }),
    context,
  );

  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    context,
  );

  await call;

  const restored = await ctx.rootClient.imps.get({ name: 'agent-src' });

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(restored));
  const stored = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          imp: {
            ...stored,

            // its awake time runs on the wall clock between the answer and the read
            resources: { ...stored.resources, awakeMs: expect.any(Number) as unknown },
          },
        },
        isError: false,
      },
    },
  ]);
});

test('it stops reporting progress for a cancelled call', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const context = {
    reply: ctx.reply,
    client: createImpClient({ url: ctx.url, token: 'root-token' }),
    guard: createImpGuard({ all: true }),
    scope: 'manage' as const,
  };

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'stubborn' },
        _meta: { progressToken: 'p' },
      },
    }),
    context,
  );

  // the command runs in the guest
  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  ctx.repeat.tick(1000);

  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }),
    context,
  );

  // a tick after the cancel, while the stubborn command still waits for its
  // SIGKILL
  ctx.repeat.tick(1000);

  await call;

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'p',
        progress: 1,
        message: expect.stringMatching(/^still running after \d+ s$/) as unknown,
      },
    },
  ]);
});
