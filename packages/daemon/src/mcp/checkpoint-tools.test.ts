import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImpGuard, createMcpServer } from '@imp/mcp';
import { createImpClient } from '@zgeoff/imp-client';
import * as z from 'zod';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createImage } from '../db/images';
import { openDatabase } from '../db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';

// impd's real app on stub VMs, a root client for the scenario, `sendToImpd`,
// which reaches the app without a socket, and an MCP server whose messages
// land parsed in `sent` through `reply`
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'mcp-checkpoint-tools-'));

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
    // a checkpoint copies every byte
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

  // the image every imps.create boots when it names none
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const sendToImpd = (request: Request) => impd.api.app.handle(request);
  const mcp = createMcpServer({ version: '1.2.3' });

  // its calls in flight end before impd stops
  stack.defer(() => mcp.close());

  const sent: unknown[] = [];

  return {
    rootClient: createImpClient({
      url: 'http://impd.test',
      token: 'root-token',
      fetch: sendToImpd,
    }),
    sendToImpd,
    mcp,
    sent,
    reply: (message: string) => {
      sent.push(JSON.parse(message));
    },
  };
}

test.each([
  ['a running', []],
  ['a sleeping', ['sleep']],
  ['a stopped', ['stop']],
] as const)('it takes a checkpoint of %s imp', async (_state, transitions) => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  for (const transition of transitions) {
    await ctx.rootClient.imps[transition]({ name: 'dev' });
  }

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_checkpoint', arguments: { name: 'dev', label: 'cp1' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const checkpoints = await ctx.rootClient.checkpoints.list({ name: 'dev' });

  // the checkpoint as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const stored: unknown = JSON.parse(JSON.stringify(checkpoints[0]));

  expect(checkpoints).toHaveLength(1);

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: { checkpoint: stored },
        isError: false,
      },
    },
  ]);
});

test.each([
  ['a running', []],
  ['a sleeping', ['sleep']],
  ['a stopped', ['stop']],
] as const)('it lists the checkpoints of %s imp', async (_state, transitions) => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'dev' });
  await ctx.rootClient.checkpoints.create({ name: 'dev', label: 'cp1' });

  for (const transition of transitions) {
    await ctx.rootClient.imps[transition]({ name: 'dev' });
  }

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_checkpoint_list', arguments: { name: 'dev' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: createImpGuard({ all: true }),
      scope: 'read',
    },
  );

  const checkpoints = await ctx.rootClient.checkpoints.list({ name: 'dev' });

  // the list as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const stored: unknown = JSON.parse(JSON.stringify(checkpoints));

  expect(checkpoints).toPartiallyContain({ label: 'cp1' });

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: { checkpoints: stored },
        isError: false,
      },
    },
  ]);
});

test.each([
  ['a running', []],
  ['a sleeping', ['sleep']],
  ['a stopped', ['stop']],
] as const)('it restores %s imp to a checkpoint', async (_state, transitions) => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'dev' });
  await ctx.rootClient.checkpoints.create({ name: 'dev', label: 'cp1' });

  for (const transition of transitions) {
    await ctx.rootClient.imps[transition]({ name: 'dev' });
  }

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_restore', arguments: { name: 'dev', checkpoint: 'cp1' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const restored = await ctx.rootClient.imps.get({ name: 'dev' });

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

test.each([
  ['a running', []],
  ['a sleeping', ['sleep']],
  ['a stopped', ['stop']],
] as const)('it deletes a checkpoint of %s imp', async (_state, transitions) => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'dev' });
  await ctx.rootClient.checkpoints.create({ name: 'dev', label: 'cp1' });

  for (const transition of transitions) {
    await ctx.rootClient.imps[transition]({ name: 'dev' });
  }

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_checkpoint_delete', arguments: { name: 'dev', checkpoint: 'cp1' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const remaining = await ctx.rootClient.checkpoints.list({ name: 'dev' });

  expect(remaining).toStrictEqual([]);

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: '{\n  "deleted": "cp1"\n}' }],
        structuredContent: { deleted: 'cp1' },
        isError: false,
      },
    },
  ]);
});

test('it answers a restore to a checkpoint that does not exist with an isError result', async () => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_restore', arguments: { name: 'dev', checkpoint: 'nope' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.stringMatching(/^NOT_FOUND: /) as unknown }],
        isError: true,
      },
    },
  ]);
});
