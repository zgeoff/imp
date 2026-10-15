import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImpClient } from '@impz/client';
import { buildApiListenOptions } from '@impz/daemon/src/api-listen-options';
import { loadConfig } from '@impz/daemon/src/config';
import { createImpd } from '@impz/daemon/src/create-impd';
import { createImage } from '@impz/daemon/src/db/images';
import { findImpByName } from '@impz/daemon/src/db/imps';
import { openDatabase } from '@impz/daemon/src/db/open-database';
import {
  buildImagePaths,
  buildImpPaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '@impz/daemon/src/storage/data-layout';
import { createXfsBackend } from '@impz/daemon/src/storage/xfs-backend';
import { buildMockNewImage } from '@impz/daemon/src/test-utils/build-mock-new-image';
import { buildQueryGate } from '@impz/daemon/src/test-utils/build-query-gate';
import { buildStubCpuCgroups } from '@impz/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubExecGuest } from '@impz/daemon/src/test-utils/build-stub-exec-guest';
import { buildStubVmm } from '@impz/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@impz/daemon/src/test-utils/find-free-ports';
import { startStubExecAgent } from '@impz/daemon/src/test-utils/start-stub-exec-agent';
import { invariant } from '@impz/test-utils/invariant';
import { waitFor } from '@impz/test-utils/wait-for';
import { INVALID_PARAMS, METHOD_NOT_FOUND } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { PROTOCOL_VERSIONS } from './create-imp-server';
import { createImpGuard } from './imp-guard';
import { buildStubAfter } from './test-utils/build-stub-after';
import { buildStubRepeat } from './test-utils/build-stub-repeat';
import { createMcpServer } from './test-utils/create-mcp-server';

// impd's real app on a loopback port for an exec's socket, a root client,
// `stack`, whose releases run before impd stops, an armed `gate` that holds
// impd's next imps read, and the replies of `mcp` or the test's own server
async function setupTest() {
  // first, so a held read lets go before impd stops
  const gate = buildQueryGate('imps');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'mcp-server-'));

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
    db: gate.wrap(db),

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

    // the host's free space, so impd never reads this machine's disk
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

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  // the image every imps.create boots when it names none
  await Bun.write(buildImagePaths(dataDir, image.digest).rootfs, 'rootfs');

  await createImage(db, image);

  const url = `http://127.0.0.1:${String(server.server?.port)}`;
  const repeat = buildStubRepeat();
  const after = buildStubAfter();

  // progress ticks only when the test steps `repeat` by 1000 ms, and a
  // stopped command's SIGKILL comes only when the test fires its 50 ms grace
  const mcp = createMcpServer({
    version: '1.2.3',
    killGraceMs: 50,
    progressIntervalMs: 1000,
    repeat: repeat.repeat,
    after: after.after,
  });

  // its calls in flight end before impd's app closes
  stack.defer(() => mcp.close());

  const sent: unknown[] = [];

  return {
    db,
    dataDir,
    stack,
    url,
    client: createImpClient({ url, token: 'root-token' }),
    mcp,
    repeat,
    after,
    gate,
    sent,
    reply: (message: string) => {
      sent.push(JSON.parse(message));
    },
  };
}

test('it supports protocol versions 2025-11-25, 2025-06-18 and 2025-03-26, newest first', () => {
  expect(PROTOCOL_VERSIONS).toStrictEqual(['2025-11-25', '2025-06-18', '2025-03-26']);
});

test.each([['2025-11-25'], ['2025-06-18'], ['2025-03-26']])(
  'it agrees on the protocol version %s',
  async (version) => {
    const ctx = await setupTest();

    const server = createMcpServer({ version: '1.2.3' });

    await server.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
      {
        reply: ctx.reply,
        client: ctx.client,
        guard: createImpGuard({ all: true }),
        scope: 'manage',
      },
    );

    expect(ctx.sent).toStrictEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'imp', title: 'imp', version: '1.2.3' },
          instructions: expect.any(String) as unknown,
        },
      },
    ]);
  },
);

test('it offers the newest protocol version for one it does not support', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
    { reply: ctx.reply, client: ctx.client, guard: createImpGuard({ all: true }), scope: 'manage' },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'imp', title: 'imp', version: '1.2.3' },
        instructions: expect.any(String) as unknown,
      },
    },
  ]);
});

test('it names the guard in the instructions it gives at initialize', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
    {
      reply: ctx.reply,
      client: ctx.client,
      guard: createImpGuard({ prefix: 'agent-' }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'imp', title: 'imp', version: '1.2.3' },
        instructions: expect.stringContaining(
          'This server may touch imps named agent-*.',
        ) as unknown,
      },
    },
  ]);
});

test('it lists every tool to a manage caller', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  const Tool = z.object({ name: z.string() });

  const tools = z.object({ result: z.object({ tools: z.array(Tool) }) }).parse(ctx.sent[0])
    .result.tools;

  expect(tools.map((tool) => tool.name)).toStrictEqual([
    'imp_list',
    'imp_create',
    'imp_destroy',
    'imp_sleep',
    'imp_url',
    'imp_fork',
    'imp_image_list',
    'imp_exec',
    'imp_read_file',
    'imp_write_file',
    'imp_checkpoint',
    'imp_checkpoint_list',
    'imp_restore',
    'imp_checkpoint_delete',
  ]);
});

test('it marks the destructive tools with a destructive hint', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  const Annotations = z.object({ destructiveHint: z.boolean().optional() });
  const Tool = z.object({ name: z.string(), annotations: Annotations });

  const tools = z.object({ result: z.object({ tools: z.array(Tool) }) }).parse(ctx.sent[0])
    .result.tools;

  expect(
    tools.filter((tool) => tool.annotations.destructiveHint === true).map((tool) => tool.name),
  ).toStrictEqual([
    'imp_destroy',
    'imp_exec',
    'imp_write_file',
    'imp_restore',
    'imp_checkpoint_delete',
  ]);
});

test('it gives every tool an object input schema', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  const Tool = z.object({ inputSchema: z.object({ type: z.string() }) });

  const tools = z.object({ result: z.object({ tools: z.array(Tool) }) }).parse(ctx.sent[0])
    .result.tools;

  expect(tools).toSatisfyAll((tool: (typeof tools)[number]) => tool.inputSchema.type === 'object');
});

test('it describes every input field of every tool', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  const Property = z.object({ description: z.string().optional() });
  const InputSchema = z.object({ properties: z.record(z.string(), Property).optional() });
  const Tool = z.object({ name: z.string(), inputSchema: InputSchema });

  const tools = z.object({ result: z.object({ tools: z.array(Tool) }) }).parse(ctx.sent[0])
    .result.tools;

  const undescribed = tools.flatMap((tool) =>
    Object.entries(tool.inputSchema.properties ?? {})
      .filter(([, property]) => property.description === undefined)
      .map(([field]) => `${tool.name}.${field}`),
  );

  expect(undescribed).toBeEmpty();
});

test('it answers ping with an empty result', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toStrictEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
});

test('it answers an unknown method with a method-not-found error', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      error: { code: METHOD_NOT_FOUND, message: 'unknown method: resources/list' },
    },
  ]);
});

test('it answers a call of an unknown tool with an invalid-params error', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_teleport', arguments: {} },
    }),
    { reply: ctx.reply, client: ctx.client, guard: createImpGuard({ all: true }), scope: 'manage' },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      error: { code: INVALID_PARAMS, message: 'unknown tool: imp_teleport' },
    },
  ]);
});

test('it refuses a call whose id a running call holds with an invalid-params error', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  const context = {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  } as const;

  ctx.gate.arm();

  const running = server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
    context,
  );

  await ctx.gate.reached;

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
    context,
  );

  const sentWhileRunning = [...ctx.sent];

  ctx.gate.release();

  await running;

  expect(sentWhileRunning).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 7,
      error: { code: INVALID_PARAMS, message: 'request 7 is already running' },
    },
  ]);
});

test('it still answers a create whose cancel arrives before the create starts', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  const context = {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  } as const;

  // the connection is open before the two lines come
  await server.receive('{"jsonrpc":"2.0","id":0,"method":"ping"}', {
    ...context,
    reply: () => {},
  });

  // both lines in one read, as one chunk of stdin brings them
  const created = server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { name: 'box' } },
    }),
    context,
  );

  const cancelled = server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    }),
    context,
  );

  await Promise.all([created, cancelled]);

  expect(ctx.sent).toMatchObject([
    {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: expect.any(String) as unknown }] },
    },
  ]);
});

test('it cancels the first call after refusing a second with its id', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  const context = {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  } as const;

  ctx.gate.arm();

  const running = server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
    context,
  );

  await ctx.gate.reached;

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
    context,
  );

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7 },
    }),
    context,
  );

  ctx.gate.release();

  await running;

  // the SDK sends no answer to a cancelled call
  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 7,
      error: { code: INVALID_PARAMS, message: 'request 7 is already running' },
    },
  ]);
});

test.each([
  ['{"jsonrpc":"2.0","method":"notifications/initialized"}'],
  ['{"jsonrpc":"2.0","id":5,"result":{}}'],
])('it sends nothing for the message %s', async (line) => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(line, {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toBeEmpty();
});

test('it still answers a cancelled create, so the agent learns the name of what it made', async () => {
  const ctx = await setupTest();

  const context = {
    reply: ctx.reply,
    client: createImpClient({ url: ctx.url, token: 'root-token' }),
    guard: createImpGuard({ prefix: 'agent-' }),
    scope: 'manage' as const,
  };

  ctx.gate.arm();

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: {} },
    }),
    context,
  );

  // the create waits inside impd while the cancel lands
  await ctx.gate.reached;

  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    context,
  );

  const sentAtCancel = [...ctx.sent];

  ctx.gate.release();

  await call;

  const [made] = await ctx.client.imps.list();

  invariant(made);

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(made));
  const stored = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  expect(sentAtCancel).toStrictEqual([]);
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

  await ctx.client.imps.create({ name: 'agent-src' });

  const context = {
    reply: ctx.reply,
    client: createImpClient({ url: ctx.url, token: 'root-token' }),
    guard: createImpGuard({ prefix: 'agent-' }),
    scope: 'manage' as const,
  };

  ctx.gate.arm();

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'agent-src' } },
    }),
    context,
  );

  // the fork waits inside impd while the cancel lands
  await ctx.gate.reached;

  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    context,
  );

  const sentAtCancel = [...ctx.sent];

  ctx.gate.release();

  await call;

  const listed = await ctx.client.imps.list();

  const fork = listed.find((imp) => imp.name !== 'agent-src');

  invariant(fork);

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(fork));
  const stored = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  expect(sentAtCancel).toStrictEqual([]);
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

  await ctx.client.imps.create({ name: 'agent-src' });
  await ctx.client.checkpoints.create({ name: 'agent-src', label: 'cp' });

  const context = {
    reply: ctx.reply,
    client: createImpClient({ url: ctx.url, token: 'root-token' }),
    guard: createImpGuard({ prefix: 'agent-' }),
    scope: 'manage' as const,
  };

  ctx.gate.arm();

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_restore', arguments: { name: 'agent-src', checkpoint: 'cp' } },
    }),
    context,
  );

  // the restore waits inside impd while the cancel lands
  await ctx.gate.reached;

  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    context,
  );

  const sentAtCancel = [...ctx.sent];

  ctx.gate.release();

  await call;

  const restored = await ctx.client.imps.get({ name: 'agent-src' });

  // the imp as it crosses impd's API, its dates as ISO strings
  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(restored));
  const stored = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  expect(sentAtCancel).toStrictEqual([]);

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

  await ctx.client.imps.create({ name: 'dev' });

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

  await waitFor(() => {
    expect(ctx.after.countPending(50)).toBe(1);
  });

  ctx.after.fire(50);

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
