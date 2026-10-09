import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '@zgeoff/imp-client';
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

// impd's real app on a loopback port, where the `imp mcp` subprocess reaches
// it, the CLI's entry the tests run it from, a root client for the scenario,
// and `stack`, whose releases run before impd stops
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'mcp-stdio-'));

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

    // the bearer the root client and the subprocess send
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

  const server = impd.api.app.listen({ port: 0, hostname: '127.0.0.1' });

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
    url,
    main: join(import.meta.dir, '..', '..', '..', 'cli', 'src', 'main.ts'),
    client: createImpClient({ url, token: 'root-token' }),
    stack,
  };
}

test('it answers initialize over stdio, and nothing for a notification', async () => {
  const ctx = await setupTest();

  const proc = Bun.spawn(['bun', ctx.main, 'mcp', '--prefix', 'agent-'], {
    env: { ...process.env, IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    proc.kill();

    await proc.exited;
  });

  const stdout = new Response(proc.stdout).text();

  await proc.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    })}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  );

  await proc.stdin.end();

  const code = await proc.exited;
  const text = await stdout;

  const messages = text
    .trimEnd()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(code).toBe(0);

  expect(messages).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'imp', title: 'imp', version: expect.any(String) as unknown },
        instructions: expect.stringContaining('imps named agent-*') as unknown,
      },
    },
  ]);
});

test('it lists its tools over stdio', async () => {
  const ctx = await setupTest();

  const proc = Bun.spawn(['bun', ctx.main, 'mcp', '--prefix', 'agent-'], {
    env: { ...process.env, IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    proc.kill();

    await proc.exited;
  });

  const stdout = new Response(proc.stdout).text();

  await proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  await proc.stdin.end();

  const code = await proc.exited;
  const text = await stdout;

  const [listed] = text.split('\n');

  invariant(listed);

  expect(code).toBe(0);

  expect(JSON.parse(listed)).toMatchObject({
    id: 2,
    result: { tools: expect.toIncludeAllPartialMembers([{ name: 'imp_exec' }]) as unknown },
  });
});

test('it answers an unknown method over stdio with method not found', async () => {
  const ctx = await setupTest();

  const proc = Bun.spawn(['bun', ctx.main, 'mcp', '--prefix', 'agent-'], {
    env: { ...process.env, IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    proc.kill();

    await proc.exited;
  });

  const stdout = new Response(proc.stdout).text();

  await proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'prompts/list' })}\n`);
  await proc.stdin.end();

  const code = await proc.exited;
  const text = await stdout;

  expect(code).toBe(0);

  expect(text).toBe(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      error: { code: -32_601, message: 'unknown method: prompts/list' },
    })}\n`,
  );
});

test('it creates an imp through impd over stdio', async () => {
  const ctx = await setupTest();

  const proc = Bun.spawn(['bun', ctx.main, 'mcp', '--prefix', 'agent-'], {
    env: { ...process.env, IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    proc.kill();

    await proc.exited;
  });

  const stdout = { text: '' };

  void (async () => {
    for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
      stdout.text += chunk;
    }
  })();

  await proc.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { name: 'agent-a', image: 'ubuntu' } },
    })}\n`,
  );

  // the call stops when the input ends, so the input ends once it answers
  const answer = await waitFor(() => {
    // the text after the first newline, empty once the answer's line is whole
    const [line, rest] = stdout.text.split('\n');

    invariant(rest);

    return line ?? '';
  });

  await proc.stdin.end();

  const imps = await ctx.client.imps.list();

  expect(JSON.parse(answer)).toMatchObject({
    id: 3,
    result: { isError: false, structuredContent: { imp: { name: 'agent-a', state: 'running' } } },
  });

  expect(imps.map((imp) => imp.name)).toStrictEqual(['agent-a']);
});

test('it runs a command in the guest over stdio', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'agent-a' });

  const record = await findImpByName(ctx.db, 'agent-a');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const proc = Bun.spawn(['bun', ctx.main, 'mcp', '--prefix', 'agent-'], {
    env: { ...process.env, IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    proc.kill();

    await proc.exited;
  });

  const stdout = { text: '' };

  void (async () => {
    for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
      stdout.text += chunk;
    }
  })();

  await proc.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'agent-a', command: 'echo from the guest' } },
    })}\n`,
  );

  // the call stops when the input ends, so the input ends once it answers
  const answer = await waitFor(() => {
    // the text after the first newline, empty once the answer's line is whole
    const [line, rest] = stdout.text.split('\n');

    invariant(rest);

    return line ?? '';
  });

  await proc.stdin.end();

  expect(JSON.parse(answer)).toMatchObject({
    id: 4,
    result: { structuredContent: { exitCode: 0, stdout: 'from the guest\n' } },
  });
});

test('it stops a command still running in the guest when the client goes away', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'box' });

  const record = await findImpByName(ctx.db, 'box');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const proc = Bun.spawn(['bun', ctx.main, 'mcp', '--allow', 'box'], {
    env: { ...process.env, IMP_URL: ctx.url, IMP_TOKEN: 'root-token' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    proc.kill();

    await proc.exited;
  });

  const stdout = new Response(proc.stdout).text();

  await proc.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
    })}\n`,
  );

  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  await proc.stdin.end();

  const code = await proc.exited;

  await waitFor(() => {
    invariant(guest.signals[0]);
  });

  const text = await stdout;

  expect(code).toBe(0);
  expect(guest.signals).toStrictEqual(['sleepy:15']);
  expect(text).toBe('');
});

test('it exits 2 without a guard and says how to choose one', async () => {
  const ctx = await setupTest();

  const proc = Bun.spawn(['bun', ctx.main, 'mcp'], {
    env: { ...process.env, IMP_URL: 'http://127.0.0.1:1' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  ctx.stack.defer(async () => {
    proc.kill();

    await proc.exited;
  });

  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  expect(code).toBe(2);
  expect(stderr).toBe('imp: choose the imps this server may touch: --prefix, --allow or --all\n');
});
