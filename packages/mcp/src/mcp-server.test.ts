import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildQueryGate } from '@imp/daemon/src/test-utils/build-query-gate';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { createImpClient } from '@zgeoff/imp-client';
import * as z from 'zod';
import { createImpGuard } from './imp-guard';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
} from './json-rpc';
import { PROTOCOL_VERSIONS, createMcpServer } from './mcp-server';

// The server's replies, parsed, and a client of impd's real app; an armed
// `gate` holds impd's next imps read.
async function setupTest() {
  // first, so a held read lets go before impd stops
  const gate = buildQueryGate('imps');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'mcp-server-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const opened = await openDatabase(':memory:');

  stack.defer(() => opened.destroy());

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

  const impd = await createImpd(config, {
    db: opened.withPlugin(gate.plugin),

    // the bearer the tools' client sends
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

  const client = createImpClient({
    url: 'http://impd.test',
    token: 'root-token',
    fetch: (request) => impd.api.app.handle(request),
  });

  const sent: unknown[] = [];

  return {
    gate,
    sent,
    reply: (message: string) => {
      sent.push(JSON.parse(message));
    },
    client,
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
        params: { protocolVersion: version },
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
      params: { protocolVersion: '2024-11-05' },
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
      params: { protocolVersion: '2025-11-25' },
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

test('it answers a request whose reply fails with an internal error', async () => {
  const ctx = await setupTest();

  const printError = mock<(message: string, error: unknown) => void>();
  const server = createMcpServer({ version: '1.2.3', printError });

  const failure = new Error('write EPIPE');

  // the transport's first write fails, as a closed pipe does
  const reply = mock(ctx.reply).mockImplementationOnce(() => {
    throw failure;
  });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), {
    reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toStrictEqual([
    { jsonrpc: '2.0', id: 1, error: { code: INTERNAL_ERROR, message: 'internal error' } },
  ]);

  expect(printError).toHaveBeenCalledExactlyOnceWith('imp mcp: request failed:', failure);
});

test('it answers a tool call whose result reply fails with an internal error', async () => {
  const ctx = await setupTest();

  const printError = mock<(message: string, error: unknown) => void>();
  const server = createMcpServer({ version: '1.2.3', printError });

  const failure = new Error('write EPIPE');

  // the transport's first write, the tool's result, fails
  const reply = mock(ctx.reply).mockImplementationOnce(() => {
    throw failure;
  });

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
    { reply, client: ctx.client, guard: createImpGuard({ all: true }), scope: 'manage' },
  );

  expect(ctx.sent).toStrictEqual([
    { jsonrpc: '2.0', id: 2, error: { code: INTERNAL_ERROR, message: 'internal error' } },
  ]);

  expect(printError).toHaveBeenCalledExactlyOnceWith('imp mcp: request failed:', failure);
});

test('it answers a line that is not JSON with a parse error and a null id', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive('not json', {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toStrictEqual([
    { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'parse error: not JSON' } },
  ]);
});

test.each([
  ['[{"jsonrpc":"2.0","id":1,"method":"ping"}]'],
  ['{"jsonrpc":"1.0","id":1,"method":"ping"}'],
  ['{"jsonrpc":"2.0","id":1}'],
])('it answers the invalid request %s with an error and a null id', async (line) => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(line, {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toStrictEqual([
    { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'invalid request' } },
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
