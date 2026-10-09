import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImpGuard, createMcpServer } from '@imp/mcp';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '@zgeoff/imp-client';
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

  const dataDir = await mkdtemp(join(tmpdir(), 'mcp-exec-tool-'));

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

test('it runs a command line through /bin/sh -c and returns its output', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

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
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'echo hi', cwd: '/srv', env: { A: '1' } },
      },
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
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: 'hi\n',
          stderr: '',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);

  expect(guest.requests).toMatchObject([
    { argv: ['/bin/sh', '-c', 'echo hi'], cwd: '/srv', env: ['A=1'] },
  ]);
});

test('it runs argv as it is, with stdin', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

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
      params: { name: 'imp_exec', arguments: { name: 'dev', argv: ['cat'], stdin: 'piped' } },
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
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: 'piped',
          stderr: '',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);

  expect(guest.requests).toMatchObject([{ argv: ['cat'] }]);
});

test('it answers a non-zero exit as a result, not a tool error', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

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
      params: { name: 'imp_exec', arguments: { name: 'dev', argv: ['fail'] } },
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
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: 3,
          signal: null,
          timedOut: false,
          stdout: 'partial',
          stderr: 'boom',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);
});

test("it passes a requirement to impd, whose refusal comes back as the tool's error", async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

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
      params: { name: 'imp_exec', arguments: { name: 'dev', argv: ['ls'], require: ['broker'] } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  // the imp holds no grant, so impd sets no broker variables and runs nothing
  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: 'PRECONDITION_FAILED: the broker is not ready for this exec: the imp has no grant, so impd sets no broker variables',
          },
        ],
        isError: true,
      },
    },
  ]);

  expect(guest.requests).toStrictEqual([]);
});

test('it refuses an unknown requirement before anything runs', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

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
      params: { name: 'imp_exec', arguments: { name: 'dev', argv: ['ls'], require: ['net'] } },
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
            text: expect.stringMatching(/^invalid arguments: .*require/s) as unknown,
          },
        ],
        isError: true,
      },
    },
  ]);

  expect(guest.requests).toStrictEqual([]);
});

test('it refuses a call with neither command nor argv', async () => {
  const ctx = await setupTest();

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev' } },
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
            text: expect.stringContaining('give either command or argv') as unknown,
          },
        ],
        isError: true,
      },
    },
  ]);
});

test('it refuses a call with both command and argv', async () => {
  const ctx = await setupTest();

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', command: 'x', argv: ['x'] } },
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
            text: expect.stringContaining('give either command or argv') as unknown,
          },
        ],
        isError: true,
      },
    },
  ]);
});

test('it refuses an outer exec in the agent, and nothing runs', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

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
      params: { name: 'imp_exec', arguments: { name: 'dev', argv: ['ls'], outer: true } },
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
          { type: 'text', text: expect.stringMatching(/^invalid arguments: .*outer/s) as unknown },
        ],
        isError: true,
      },
    },
  ]);

  expect(guest.requests).toStrictEqual([]);
});

test('it keeps the head and the tail of a large output and counts what it dropped', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

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
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'flood 1000000', maxOutputBytes: 16_384 },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  // 8 KiB of head and 8 KiB of tail around the marker; `flood` fills
  // between HEAD and TAIL with x
  const stdout = [
    `HEAD${'x'.repeat(8192 - 4)}`,
    `\n[... ${String(1_000_000 - 16_384)} bytes dropped ...]\n`,
    `${'x'.repeat(8192 - 4)}TAIL`,
  ].join('');

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout,
          stderr: '',
          stdoutDroppedBytes: 1_000_000 - 16_384,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);
});

test('it sends SIGTERM to a command at its timeout and reports timedOut', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  // the tool's timeout runs on a real timer: its shortest is a second
  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'sleepy', timeoutSeconds: 1 },
      },
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
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: true,
          stdout: '',
          stderr: '',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);

  expect(guest.signals).toStrictEqual(['sleepy:15']);

  // the agent kills what is left of the group itself, given the grace: no
  // second exec
  expect(guest.requests).toMatchObject([{ argv: ['/bin/sh', '-c', 'sleepy'], killGraceMs: 50 }]);
});

// before protocol 0.8.0 the rest of the group outlives the stop until the
// imp restarts (docs/guides/operations.md#upgrade)
test('it opens no second exec to stop a command on an agent from before the group kill', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest({ oldAgent: true });

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  // the tool's timeout runs on a real timer: its shortest is a second
  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'sleepy', timeoutSeconds: 1 },
      },
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
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: true,
          stdout: '',
          stderr: '',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);

  expect(guest.requests).toMatchObject([{ argv: ['/bin/sh', '-c', 'sleepy'] }]);
});

test('it sends SIGKILL after the grace to a command that ignores SIGTERM', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  // the tool's timeout runs on a real timer: its shortest is a second
  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'stubborn', timeoutSeconds: 1 },
      },
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
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: null,
          signal: 'SIGKILL',
          timedOut: true,
          stdout: '',
          stderr: '',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);

  expect(guest.signals).toStrictEqual(['stubborn:15', 'stubborn:9']);

  // the session carried SIGKILL to the whole group: no sweep
  expect(guest.requests).toMatchObject([{ argv: ['/bin/sh', '-c', 'stubborn'] }]);
});

test('it stops a cancelled exec and sends no response', async () => {
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
      id: 7,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', command: 'stubborn' } },
    }),
    context,
  );

  // the command runs in the guest
  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7, reason: 'user' },
    }),
    context,
  );

  await call;

  expect(ctx.sent).toStrictEqual([]);
  expect(guest.signals).toStrictEqual(['stubborn:15', 'stubborn:9']);
});

test('it stops every call in flight on close, as when the client goes away', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', command: 'sleepy' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  // the command runs in the guest
  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  await ctx.mcp.close();

  await call;

  expect(ctx.sent).toStrictEqual([]);
  expect(guest.signals).toStrictEqual(['sleepy:15']);
});

test('it sends a progress notification on each tick while a call with a progress token runs', async () => {
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
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'sleepy' },
        _meta: { progressToken: 'p1' },
      },
    }),
    context,
  );

  // the command runs in the guest
  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  ctx.repeat.tick(1000);
  ctx.repeat.tick(1000);

  // the cancel ends the call, which then sends nothing more
  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    context,
  );

  await call;

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'p1',
        progress: 1,
        message: expect.stringMatching(/^still running after \d+ s$/) as unknown,
      },
    },
    {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'p1',
        progress: 2,
        message: expect.stringMatching(/^still running after \d+ s$/) as unknown,
      },
    },
  ]);
});

test('it boots a stopped imp for an exec', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.rootClient.imps.stop({ name: 'dev' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', command: 'echo up' } },
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
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: 'up\n',
          stderr: '',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);
});

test('it leaves a stopped imp running after an exec', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.rootClient.imps.stop({ name: 'dev' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', command: 'echo up' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const imp = await ctx.rootClient.imps.get({ name: 'dev' });

  expect(imp.state).toBe('running');
});
