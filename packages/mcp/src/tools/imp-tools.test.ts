import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import { createImage } from '@imp/daemon/src/db/images';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { createImpClient } from '@zgeoff/imp-client';
import * as z from 'zod';
import { createImpGuard } from '../imp-guard';
import { createMcpServer } from '../mcp-server';
import { buildStubOlderImpdFetch } from '../test-utils/build-stub-older-impd-fetch';

// impd's real app on stub VMs, with its database and data dir, a root client
// for the scenario, and `sendToImpd`, which reaches the app without a socket
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'mcp-imp-tools-'));

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

    // a new disk stays the size of its image, since the clone copies every
    // byte of a fork's disk
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

    // a frozen clock, so a later read of the fork matches the answer to it
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

  const rootClient = createImpClient({
    url: 'http://impd.test',
    token: 'root-token',
    fetch: sendToImpd,
  });

  return { db, rootClient, sendToImpd };
}

test('it reports beside the fork each grant it did not get', async () => {
  const ctx = await setupTest();

  const mcp = createMcpServer({ version: '1.2.3' });
  const sent: unknown[] = [];

  await ctx.rootClient.imps.create({ name: 'dev-a' });
  await ctx.rootClient.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-1' });
  await ctx.rootClient.grants.add({ name: 'dev-a', secret: 'gh' });

  // a token that may grant no secret, so the fork may not copy gh
  const made = await ctx.rootClient.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
  });

  await mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'dev-a', name: 'dev-b' } },
    }),
    {
      reply: (message) => {
        sent.push(JSON.parse(message));
      },
      client: createImpClient({
        url: 'http://impd.test',
        token: made.secret,
        fetch: ctx.sendToImpd,
      }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const forked = await ctx.rootClient.imps.get({ name: 'dev-b' });

  // the fork as it crosses impd's API, its dates as ISO strings, which a
  // structuredClone would keep as dates
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(forked));
  const read = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  // its awake time runs on the wall clock between the answer and the read
  const wire = {
    ...read,
    resources: { ...read.resources, awakeMs: expect.any(Number) as unknown },
  };

  expect(sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          imp: wire,
          grantsNotCopied: [{ secret: 'gh', reason: 'not-grantable' }],
        },
        isError: false,
      },
    },
  ]);
});

test('it reports an empty grant report beside a fork that got every grant', async () => {
  const ctx = await setupTest();

  const mcp = createMcpServer({ version: '1.2.3' });
  const sent: unknown[] = [];

  await ctx.rootClient.imps.create({ name: 'dev-a' });

  await mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'dev-a', name: 'dev-b' } },
    }),
    {
      reply: (message) => {
        sent.push(JSON.parse(message));
      },
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const forked = await ctx.rootClient.imps.get({ name: 'dev-b' });

  // the fork as it crosses impd's API, its dates as ISO strings, which a
  // structuredClone would keep as dates
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(forked));
  const read = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  // its awake time runs on the wall clock between the answer and the read
  const wire = {
    ...read,
    resources: { ...read.resources, awakeMs: expect.any(Number) as unknown },
  };

  expect(sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          imp: wire,
          grantsNotCopied: [],
        },
        isError: false,
      },
    },
  ]);
});

test('it reports beside the fork why it got none of the grants', async () => {
  const ctx = await setupTest();

  const mcp = createMcpServer({ version: '1.2.3' });
  const sent: unknown[] = [];

  await ctx.rootClient.imps.create({ name: 'dev-a' });

  // the grant copy's first read fails, as a broken database fails it
  await ctx.db.schema.dropTable('grants').execute();

  await mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'dev-a', name: 'dev-b' } },
    }),
    {
      reply: (message) => {
        sent.push(JSON.parse(message));
      },
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const forked = await ctx.rootClient.imps.get({ name: 'dev-b' });

  // the fork as it crosses impd's API, its dates as ISO strings, which a
  // structuredClone would keep as dates
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(forked));
  const read = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  // its awake time runs on the wall clock between the answer and the read
  const wire = {
    ...read,
    resources: { ...read.resources, awakeMs: expect.any(Number) as unknown },
  };

  expect(sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          imp: wire,
          grantsNotCopied: [],
          grantsError:
            "the source's grants could not be copied, so the fork has none; impd's log has the cause",
        },
        isError: false,
      },
    },
  ]);
});

test('it leaves the grant report out of a fork from an impd that sends none', async () => {
  const ctx = await setupTest();

  const mcp = createMcpServer({ version: '1.2.3' });
  const sent: unknown[] = [];

  await ctx.rootClient.imps.create({ name: 'dev-a' });

  await mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'dev-a', name: 'dev-b' } },
    }),
    {
      reply: (message) => {
        sent.push(JSON.parse(message));
      },
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',

        // an impd release from before the fork's grant report
        fetch: buildStubOlderImpdFetch(ctx.sendToImpd),
      }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const forked = await ctx.rootClient.imps.get({ name: 'dev-b' });

  // the fork as it crosses impd's API, its dates as ISO strings, which a
  // structuredClone would keep as dates
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(forked));
  const read = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  // its awake time runs on the wall clock between the answer and the read
  const wire = {
    ...read,
    resources: { ...read.resources, awakeMs: expect.any(Number) as unknown },
  };

  expect(sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: { imp: wire },
        isError: false,
      },
    },
  ]);
});

test('it gives the fork as indented JSON text beside its structured content', async () => {
  const ctx = await setupTest();

  const mcp = createMcpServer({ version: '1.2.3' });
  const sent: unknown[] = [];

  await ctx.rootClient.imps.create({ name: 'dev-a' });

  await mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'dev-a', name: 'dev-b' } },
    }),
    {
      reply: (message) => {
        sent.push(JSON.parse(message));
      },
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const Text = z.object({ text: z.string() });
  const Result = z.object({ content: z.tuple([Text]), structuredContent: z.unknown() });
  const result = z.object({ result: Result }).parse(sent[0]).result;

  expect(result.content[0].text).toBe(JSON.stringify(result.structuredContent, null, 2));
});
