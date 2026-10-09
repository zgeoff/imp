import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImpGuard, createMcpServer } from '@imp/mcp';
import { invariant } from '@imp/test-utils/invariant';
import { createImpClient } from '@zgeoff/imp-client';
import * as z from 'zod';
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
// messages land parsed in `sent` through `reply`
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
  const mcp = createMcpServer({ version: '1.2.3' });

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
    sent,
    reply: (message: string) => {
      sent.push(JSON.parse(message));
    },
  };
}

test('it creates an imp and answers with it as impd stores it', async () => {
  const ctx = await setupTest();

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { name: 'dev', image: 'ubuntu' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const created = await ctx.rootClient.imps.get({ name: 'dev' });

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(created));
  const stored = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  expect(created.state).toBe('running');

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

test('it lists the imps with their state', async () => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'dev' });
  await ctx.rootClient.imps.create({ name: 'off' });
  await ctx.rootClient.imps.stop({ name: 'off' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'read',
    },
  );

  const dev = await ctx.rootClient.imps.get({ name: 'dev' });
  const off = await ctx.rootClient.imps.get({ name: 'off' });

  // the imps as they cross impd's API, their dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify([dev, off]));

  const [storedDev, storedOff] = z
    .tuple([
      z.looseObject({ resources: z.looseObject({}) }),
      z.looseObject({ resources: z.looseObject({}) }),
    ])
    .parse(json);

  expect(dev.state).toBe('running');
  expect(off.state).toBe('stopped');

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          imps: [
            {
              ...storedDev,

              // its awake time runs on the wall clock between the answer and the read
              resources: { ...storedDev.resources, awakeMs: expect.any(Number) as unknown },
            },
            {
              ...storedOff,
              resources: { ...storedOff.resources, awakeMs: expect.any(Number) as unknown },
            },
          ],
        },
        isError: false,
      },
    },
  ]);
});

test('it gives the list as JSON text, dates as ISO strings, that parses to its structured content', async () => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'read',
    },
  );

  const Text = z.object({ text: z.string() });
  const Result = z.object({ content: z.tuple([Text]), structuredContent: z.unknown() });
  const result = z.object({ result: Result }).parse(ctx.sent[0]).result;

  expect(JSON.parse(result.content[0].text)).toStrictEqual(result.structuredContent);
});

test('it hides the imps the guard does not allow from the list', async () => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'prod' });
  await ctx.rootClient.imps.create({ name: 'agent-one' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ prefix: 'agent-' }),
      scope: 'manage',
    },
  );

  const allowed = await ctx.rootClient.imps.get({ name: 'agent-one' });

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(allowed));
  const stored = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          imps: [
            {
              ...stored,

              // its awake time runs on the wall clock between the answer and the read
              resources: { ...stored.resources, awakeMs: expect.any(Number) as unknown },
            },
          ],
        },
        isError: false,
      },
    },
  ]);
});

test.each([
  ['imp_destroy', { name: 'prod' }],
  ['imp_restore', { name: 'prod', checkpoint: 'x' }],
  ['imp_exec', { name: 'prod', command: 'echo hi' }],
  ['imp_write_file', { name: 'prod', path: '/x', content: 'x' }],
  ['imp_fork', { source: 'prod', name: 'agent-two' }],
  ['imp_fork', { source: 'agent-one', name: 'other' }],
  ['imp_create', { name: 'other' }],
] as const)('it refuses %s with %o past the guard before impd acts', async (tool, args) => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'prod' });
  await ctx.rootClient.imps.create({ name: 'agent-one' });

  const record = await findImpByName(ctx.db, 'prod');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ prefix: 'agent-' }),
      scope: 'manage',
    },
  );

  const remaining = await ctx.rootClient.imps.list();

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.stringMatching(/^GUARD: /) as unknown }],
        isError: true,
      },
    },
  ]);

  expect(remaining.map((imp) => imp.name)).toStrictEqual(['agent-one', 'prod']);
  expect(guest.requests).toStrictEqual([]);
});

test('it names a nameless create under the prefix', async () => {
  const ctx = await setupTest();

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { image: 'ubuntu' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ prefix: 'agent-' }),
      scope: 'manage',
    },
  );

  const imps = await ctx.rootClient.imps.list();

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(imps));
  const [stored] = z.tuple([z.looseObject({ resources: z.looseObject({}) })]).parse(json);

  expect(imps).toMatchObject([{ name: expect.stringMatching(/^agent-[a-z0-9]{8}$/) as unknown }]);

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

test('it refuses a nameless create under an allow-list alone', async () => {
  const ctx = await setupTest();

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { image: 'ubuntu' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ allow: ['box'] }),
      scope: 'manage',
    },
  );

  const imps = await ctx.rootClient.imps.list();

  expect(imps).toStrictEqual([]);

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: 'GUARD: give a name: the imps box' }],
        isError: true,
      },
    },
  ]);
});

test('it creates an imp the allow-list names', async () => {
  const ctx = await setupTest();

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { name: 'box', image: 'ubuntu' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ allow: ['box'] }),
      scope: 'manage',
    },
  );

  const created = await ctx.rootClient.imps.get({ name: 'box' });

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(created));
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

test('it puts an imp to sleep', async () => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_sleep', arguments: { name: 'dev' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const slept = await ctx.rootClient.imps.get({ name: 'dev' });

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(slept));
  const stored = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  expect(slept.state).toBe('sleeping');

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

test("it answers with an imp's URLs", async () => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_url', arguments: { name: 'dev' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'read',
    },
  );

  // impd has no domain, public listener or tailnet here, so only the local
  // URL is set
  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          local: 'http://dev.imp.localhost:7080',
          https: null,
          public: null,
          service: null,
          tailnet: null,
        },
        isError: false,
      },
    },
  ]);
});

test('it destroys an imp', async () => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_destroy', arguments: { name: 'dev' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const remaining = await ctx.rootClient.imps.list();

  expect(remaining).toStrictEqual([]);

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: '{\n  "destroyed": "dev"\n}' }],
        structuredContent: { destroyed: 'dev' },
        isError: false,
      },
    },
  ]);
});

test("it answers impd's error as an isError result led by its code", async () => {
  const ctx = await setupTest();

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_sleep', arguments: { name: 'ghost' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
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

test('it answers arguments that fail the schema with an isError result naming each field', async () => {
  const ctx = await setupTest();

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { name: 'Not A Name', extra: 1 } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: expect.toSatisfy(
              (text: string) =>
                text.startsWith('invalid arguments: ') &&
                text.includes('→ at name') &&
                text.includes('extra'),
            ) as unknown,
          },
        ],
        isError: true,
      },
    },
  ]);
});

test('it lists the images', async () => {
  const ctx = await setupTest();

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_image_list', arguments: {} },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'read',
    },
  );

  const images = await ctx.rootClient.images.list();

  // the list as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const stored: unknown = JSON.parse(JSON.stringify(images));

  expect(images).toPartiallyContain({ name: 'ubuntu' });

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: { images: stored },
        isError: false,
      },
    },
  ]);
});

test('it forks a sleeping imp from a checkpoint', async () => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'asleep' });
  await ctx.rootClient.checkpoints.create({ name: 'asleep', label: 'before' });
  await ctx.rootClient.imps.sleep({ name: 'asleep' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_fork',
        arguments: { source: 'asleep', name: 'fork-a', checkpoint: 'before' },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const forked = await ctx.rootClient.imps.get({ name: 'fork-a' });

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(forked));
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
          grantsNotCopied: [],
        },
        isError: false,
      },
    },
  ]);
});

test('it forks a stopped imp as it is now', async () => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'off' });
  await ctx.rootClient.imps.stop({ name: 'off' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'off', name: 'fork-b' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const forked = await ctx.rootClient.imps.get({ name: 'fork-b' });

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(forked));
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
          grantsNotCopied: [],
        },
        isError: false,
      },
    },
  ]);
});

test('it names beside the fork the grants a scoped token could not copy', async () => {
  const ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'dev-a' });
  await ctx.rootClient.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-168' });
  await ctx.rootClient.grants.add({ name: 'dev-a', secret: 'gh' });

  // a token that may grant no secret, so the fork may not copy gh
  const made = await ctx.rootClient.tokens.create({
    name: 'mcp',
    scope: 'manage',
    imps: ['dev-*'],
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'dev-a', name: 'dev-b' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: made.secret }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const forked = await ctx.rootClient.imps.get({ name: 'dev-b' });

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(forked));
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
          grantsNotCopied: [{ secret: 'gh', reason: 'not-grantable' }],
        },
        isError: false,
      },
    },
  ]);
});
