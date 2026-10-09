import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '@zgeoff/imp-client';
import { buildApiListenOptions } from '../api-listen-options';
import type { TailnetPeer } from '../auth/tailnet-identity';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { listApiCalls } from '../db/api-audit';
import { createImage } from '../db/images';
import { findImpByName } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { PEER_HEADER } from '../proxy/forwarded-peers';
import { startWakeProxy } from '../proxy/wake-proxy';
import { buildImpPaths, buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubExecGuest } from '../test-utils/build-stub-exec-guest';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubExecAgent } from '../test-utils/start-stub-exec-agent';

interface SetupOptions {
  // impd's environment past what every test boots with
  readonly env?: Readonly<Record<string, string>>;

  // `tailscale whois`; nobody on the tailnet by default
  readonly whois?: (address: string) => Promise<TailnetPeer | null>;

  // the API's idle timeout in seconds; main.ts's by default
  readonly idleTimeoutS?: number;
}

// impd's real app on a loopback port, as a remote agent reaches /mcp, a root
// client for the scenario, and `stack`, whose releases run before impd stops
async function setupTest(options: SetupOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'mcp-endpoint-'));

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
    ...options.env,
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
    whois: options.whois ?? (() => Promise.resolve(null)),
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
    ...buildApiListenOptions(config, options.idleTimeoutS),
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

  return {
    db,
    dataDir,
    config,
    impd,
    url,
    client: createImpClient({ url, token: 'root-token' }),
    stack,
  };
}

test('it names a nameless create under the one prefix its token may touch', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
  });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { image: 'ubuntu' } },
    }),
  });

  const body: unknown = await response.json();

  expect(body).toMatchObject({
    id: 1,
    result: {
      isError: false,
      structuredContent: { imp: { name: expect.stringMatching(/^agent-[a-z0-9]{8}$/) as unknown } },
    },
  });
});

test('it audits a tool call as the token that made it', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
  });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { name: 'agent-a', image: 'ubuntu' } },
    }),
  });

  const calls = await listApiCalls(ctx.db, 'agent-a', 10, null);

  expect(calls).toPartiallyContain({ procedure: 'imps.create', actorName: 'agent', outcome: 'ok' });
});

test('it runs a command in an imp its token may touch', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'agent-a' });

  const record = await findImpByName(ctx.db, 'agent-a');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
  });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'agent-a', command: 'echo hi' } },
    }),
  });

  const body: unknown = await response.json();

  expect(body).toMatchObject({
    id: 1,
    result: { isError: false, structuredContent: { exitCode: 0, stdout: 'hi\n' } },
  });
});

test('it refuses a create outside the patterns of its token', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
  });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { name: 'other', image: 'ubuntu' } },
    }),
  });

  const body: unknown = await response.json();

  expect(body).toMatchObject({
    id: 1,
    result: {
      isError: true,
      content: [{ type: 'text', text: expect.stringMatching(/^FORBIDDEN: /) as unknown }],
    },
  });
});

test('it lists only the read tools to a read token', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': session,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

  const body: unknown = await response.json();

  expect(body).toMatchObject({
    id: 1,
    result: {
      tools: [
        { name: 'imp_list' },
        { name: 'imp_url' },
        { name: 'imp_image_list' },
        { name: 'imp_checkpoint_list' },
      ],
    },
  });
});

test('it lists the imps to a read token', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
  });

  const body: unknown = await response.json();

  expect(body).toMatchObject({
    id: 1,
    result: { isError: false, structuredContent: { imps: [{ name: 'box' }] } },
  });
});

test.each([
  ['imp_exec', { name: 'box', command: 'echo hi' }],
  ['imp_write_file', { name: 'box', path: '/x', content: 'x' }],
  ['imp_destroy', { name: 'box' }],
])('it refuses %s to a read token before it reaches the guest', async (tool, args) => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'box' });

  const record = await findImpByName(ctx.db, 'box');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });

  const body: unknown = await response.json();

  expect(body).toMatchObject({
    id: 1,
    result: {
      isError: true,
      content: [{ type: 'text', text: expect.stringMatching(/^FORBIDDEN: /) as unknown }],
    },
  });

  expect(guest.requests).toStrictEqual([]);
});

test('it refuses a fork to a token that may grant secrets', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'agent-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
    grantable: ['gh'],
  });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'agent-a', name: 'agent-b' } },
    }),
  });

  const body: unknown = await response.json();
  const imps = await ctx.client.imps.list();

  expect(body).toMatchObject({
    id: 1,
    result: {
      isError: true,
      content: [{ type: 'text', text: expect.stringMatching(/^FORBIDDEN: /) as unknown }],
    },
  });

  expect(imps.map((imp) => imp.name)).toStrictEqual(['agent-a']);
});

test('it asks a token with two patterns to name the imp it creates', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'two',
    scope: 'manage',
    imps: ['a-*', 'b-*'],
  });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { image: 'ubuntu' } },
    }),
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [
        {
          type: 'text',
          text: 'GUARD: this token may touch only imps matching a-*, b-*, so give the new imp a name that matches',
        },
      ],
      isError: true,
    },
  });
});

test('it refuses a session to a caller other than the one that opened it', async () => {
  const ctx = await setupTest();
  const first = await ctx.client.tokens.create({ name: 'first', scope: 'read' });
  const second = await ctx.client.tokens.create({ name: 'second', scope: 'read' });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${first.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${second.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(response.status).toBe(404);
});

test('it ends the streamed call and running command of a token that is removed', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'box' });

  const record = await findImpByName(ctx.db, 'box');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const made = await ctx.client.tokens.create({ name: 'agent', scope: 'exec' });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const call = fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
    }),
  });

  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  await ctx.client.tokens.delete({ name: 'agent' });

  const response = await call;
  const text = await response.text();

  await waitFor(() => {
    invariant(guest.closed[0]);
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');

  // the stream closed with no answer to the call
  expect(
    text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line): unknown => JSON.parse(line.slice('data: '.length))),
  ).toStrictEqual([]);

  expect(guest.closed).toStrictEqual(['sleepy']);
});

test('it refuses the session of a removed token with 401', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'agent', scope: 'exec' });

  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  await ctx.client.tokens.delete({ name: 'agent' });

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${made.secret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

  expect(response.status).toBe(401);
});

test('it refuses a caller with no token and no handed-over address with 401', async () => {
  const ctx = await setupTest({
    env: {
      IMP_TAILNET_IDENTITIES:
        '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
    },
  });

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  expect(response.status).toBe(401);
});

test('it serves a tailnet identity the wake proxy hands over the imps its rule allows', async () => {
  const ctx = await setupTest({
    // alice's laptop may exec on dev-* imps
    env: {
      IMP_TAILNET_IDENTITIES:
        '[{"match":"user:alice@example.com","scope":"exec","imps":["dev-*"]}]',
    },
    whois: (address) => {
      const peers = new Map([
        [
          '100.101.102.103',
          { login: 'alice@example.com', tags: [], node: 'laptop', stableId: null },
        ],
      ]);

      return Promise.resolve(peers.get(address) ?? null);
    },
  });

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });

  // each request comes as the wake proxy sends it, with alice's address
  const opened = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      [PEER_HEADER]: ctx.impd.peers.register('100.101.102.103'),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'atc' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': session,
      [PEER_HEADER]: ctx.impd.peers.register('100.101.102.103'),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
  });

  const body: unknown = await response.json();

  expect(body).toMatchObject({
    id: 1,
    result: { isError: false, structuredContent: { imps: [{ name: 'dev-a' }] } },
  });
});

// a 400, not a 403, once past the origin check: the ping has no session
test.each([
  ['an Origin on another site', { origin: 'http://evil.example' }, 403],
  ['a cross-site Sec-Fetch-Site', { 'sec-fetch-site': 'cross-site' }, 403],
  [
    'a same-site Sec-Fetch-Site',
    { 'sec-fetch-site': 'same-site', origin: 'http://impd.example' },
    403,
  ],
  [
    'a same-origin Sec-Fetch-Site whatever the Origin',
    { 'sec-fetch-site': 'same-origin', origin: 'http://evil.example' },
    400,
  ],
  ['its own host as the Origin, over another scheme', { origin: 'https://impd.example' }, 400],
])('it answers a page that sends %s with %d', async (_label, headers, status) => {
  const ctx = await setupTest();

  const response = await fetch(`${ctx.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer root-token',
      host: 'impd.example',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
  });

  expect(response.status).toBe(status);
});

test('it answers a tool call through the wake proxy’s API route', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  // the proxy's API route, as the HTTPS domain serves impd
  const proxy = startWakeProxy({
    config: {
      ...ctx.config,
      apiPort: Number(new URL(ctx.url).port),
      proxyPort: findFreePorts(1).take(),
    },
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: ctx.impd.peers,
  });

  ctx.stack.defer(() => proxy.stop());

  const front = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => front.stop(true));

  const via = `http://127.0.0.1:${String(front.port)}`;

  const opened = await fetch(`${via}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer root-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await fetch(`${via}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer root-token',
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
  });

  const body: unknown = await response.json();

  expect(body).toMatchObject({
    id: 1,
    result: { isError: false, structuredContent: { imps: [{ name: 'box' }] } },
  });
});

test('it answers a JSON tool call that outlasts the idle timeout through the wake proxy', async () => {
  const ctx = await setupTest({ idleTimeoutS: 1 });

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'box' });

  const record = await findImpByName(ctx.db, 'box');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  // the proxy's API route, as the HTTPS domain serves impd
  const proxy = startWakeProxy({
    config: {
      ...ctx.config,
      apiPort: Number(new URL(ctx.url).port),
      proxyPort: findFreePorts(1).take(),
    },
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: ctx.impd.peers,
  });

  ctx.stack.defer(() => proxy.stop());

  const front = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => front.stop(true));

  const via = `http://127.0.0.1:${String(front.port)}`;

  const opened = await fetch(`${via}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer root-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const call = fetch(`${via}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer root-token',
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'box', command: 'wait 6000' } },
    }),
  });

  const response = await call;
  const text = await response.text();

  expect(response.headers.get('content-type')).toBe('application/json');

  expect(JSON.parse(text)).toMatchObject({
    id: 1,
    result: { isError: false, structuredContent: { exitCode: 0, stdout: 'waited\n' } },
  });
}, 20_000);

test('it keeps a call answered as server-sent events open through the wake proxy past the idle timeout that ends an unprotected stream', async () => {
  const ctx = await setupTest({ idleTimeoutS: 1 });

  // the guest's `wait` runs until the test lets it end
  const done = Promise.withResolvers<void>();
  const guest = buildStubExecGuest({ wait: () => done.promise });

  // the guest's command ends before impd stops
  ctx.stack.defer(() => {
    done.resolve();
  });

  await ctx.client.imps.create({ name: 'box' });

  const record = await findImpByName(ctx.db, 'box');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  // the proxy's API route, as the HTTPS domain serves impd
  const proxy = startWakeProxy({
    config: {
      ...ctx.config,
      apiPort: Number(new URL(ctx.url).port),
      proxyPort: findFreePorts(1).take(),
    },
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: ctx.impd.peers,
  });

  ctx.stack.defer(() => proxy.stop());

  const front = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => front.stop(true));

  const via = `http://127.0.0.1:${String(front.port)}`;

  const opened = await fetch(`${via}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer root-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    }),
  });

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const call = fetch(`${via}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer root-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'box', command: 'wait 1' } },
    }),
  });

  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  // impd's event stream on /rpc, which lifts no idle timeout: its keepalive
  // comes every 5 s, as the MCP stream's does, so the deadline ends it first
  const control = await fetch(`${ctx.url}/rpc/events/stream`, {
    method: 'POST',
    headers: { authorization: 'Bearer root-token', 'content-type': 'application/json' },
    body: '{}',
  });

  const [expired] = await Promise.allSettled([control.text()]);

  done.resolve();

  const response = await call;
  const text = await response.text();

  expect(expired).toMatchObject({ status: 'rejected', reason: { code: 'ECONNRESET' } });
  expect(response.headers.get('content-type')).toBe('text/event-stream');

  expect(
    text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line): unknown => JSON.parse(line.slice('data: '.length))),
  ).toMatchObject([
    {
      id: 1,
      result: { isError: false, structuredContent: { exitCode: 0, stdout: 'waited\n' } },
    },
  ]);
}, 20_000);
