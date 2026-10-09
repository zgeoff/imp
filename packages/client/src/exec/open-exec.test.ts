import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSOLE_SHELL } from '@imp/api';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import type { ImpdDeps } from '@imp/daemon/src/create-impd';
import { createImage } from '@imp/daemon/src/db/images';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import {
  buildImpPaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { startStubAgent } from '@imp/daemon/src/test-utils/start-stub-agent';
import { server } from '@imp/test-utils/mock-server';
import { waitFor } from '@imp/test-utils/wait-for';
import { ORPCError } from '@orpc/client';
import { http } from 'msw';
import { createImpClient } from '../create-imp-client';
import {
  STUB_BOOT_ID,
  STUB_FLOOD_BYTES,
  STUB_GENERATION,
  buildStubExecAgent,
} from '../test-utils/build-stub-exec-agent';
import { buildStubImpdBeforeExecRequire } from '../test-utils/build-stub-impd-before-exec-require';
import { ExecError } from './exec-error';
import { InvalidResumeError } from './invalid-resume-error';
import { InvalidStateError } from './invalid-state-error';
import { NoSessionError } from './no-session-error';

// impd on stub VMs, listening on a loopback port for /exec, with the imp
// `dev` and the stub agent on its vsock; also served at http://impd.test/
// through the run's MSW server, so a test can answer as an older impd
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // impd boots with a root token, the bearer the test's client sends
  const rootToken = 'root-token';

  const dataDir = await mkdtemp(join(tmpdir(), 'imp-client-exec-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  // the image `dev` boots
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const vmm = buildStubVmm();

  // an agent with sessions, kill graces and session logs
  vmm.agent.version = '0.18.0';

  const deps: ImpdDeps = {
    db,

    rootToken,
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
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
  };

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
  });

  const impd = await createImpd(config, deps);

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  impd.api.app.listen({ port: 0, hostname: '127.0.0.1' });

  stack.defer(async () => {
    await impd.api.app.stop(true);
  });

  server.use(http.all('http://impd.test/*', (info) => impd.api.app.handle(info.request)));

  const url = `http://127.0.0.1:${String(impd.api.app.server?.port)}`;
  const client = createImpClient({ url, token: rootToken });

  // the imp every exec runs in, and its agent
  const dev = await client.imps.create({ name: 'dev' });

  const agent = buildStubExecAgent();

  const agentServer = await startStubAgent(
    buildImpPaths(dataDir, dev.id).vsockSocket,
    agent.readFrame,
  );

  stack.defer(() => {
    agentServer.close();
  });

  return { impd, url, client, agent, rootToken };
}

test('#runCommand collects both streams and the exit code', async () => {
  const ctx = await setupTest();
  const result = await ctx.client.run('dev', ['fail']);

  expect(result).toStrictEqual({
    code: 3,
    signal: null,
    stdout: new TextEncoder().encode('out'),
    stderr: new TextEncoder().encode('err'),
  });
});

test('#runCommand sends its stdin and closes it', async () => {
  const ctx = await setupTest();
  const result = await ctx.client.run('dev', ['cat'], { stdin: 'hello', cwd: '/srv' });

  expect(new TextDecoder().decode(result.stdout)).toBe('hello');
  expect(ctx.agent.input).toStrictEqual(['hello', 'eof']);
  expect(ctx.agent.requests).toMatchObject([{ argv: ['cat'], tty: false, cwd: '/srv' }]);
});

test('#runCommand drains both streams at once', async () => {
  const ctx = await setupTest();
  const result = await ctx.client.run('dev', ['big']);

  expect(result.stdout).toStrictEqual(new Uint8Array(STUB_FLOOD_BYTES).fill(111));
  expect(result.stderr).toStrictEqual(new Uint8Array(STUB_FLOOD_BYTES).fill(101));
});

test('#runCommand sends a stdin over 16 MiB in frames impd takes', async () => {
  const ctx = await setupTest();

  // impd, as Bun serves it, closes a socket that sends one frame over 16 MiB
  const stdin = 'a'.repeat(17 * 1024 ** 2);

  const result = await ctx.client.run('dev', ['cat'], { stdin });

  expect(result.code).toBe(0);
  expect(result.stdout).toHaveLength(stdin.length);
});

// a fast command over a slow link: its exit can arrive with its start
test('#runCommand returns the exit and output of a command that exits as it starts', async () => {
  const ctx = await setupTest();
  const result = await ctx.client.run('dev', ['fail'], { stdin: 'unread' });

  expect(result).toStrictEqual({
    code: 3,
    signal: null,
    stdout: new TextEncoder().encode('out'),
    stderr: new TextEncoder().encode('err'),
  });
});

test('#runCommand rejects with the agent code of a command that cannot start', async () => {
  const ctx = await setupTest();

  const running = ctx.client.run('dev', ['nope']);

  expect(running).rejects.toBeInstanceOf(ExecError);
  expect(running).rejects.toMatchObject({ code: 'EXEC_FAILED' });
});

test('#runCommand rejects with NOT_FOUND for an imp that does not exist', async () => {
  const ctx = await setupTest();

  // the ticket is refused before any socket opens
  const running = ctx.client.run('ghost', ['cat']);

  expect(running).rejects.toBeInstanceOf(ORPCError);
  expect(running).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('#openExec streams stdout as the command writes it', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['cat']);

  const reader = handle.stdout.getReader();

  await handle.write('one');

  const first = await reader.read();

  await handle.write(new TextEncoder().encode('two'));

  const second = await reader.read();

  await handle.closeStdin();

  const exit = await handle.exit;

  expect(first.value).toStrictEqual(new TextEncoder().encode('one'));
  expect(second.value).toStrictEqual(new TextEncoder().encode('two'));
  expect(exit).toStrictEqual({ code: 0, signal: null });
});

test('#openExec sends a signal as a signal without a tty', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['wait']);

  await handle.started;

  handle.sendSignal('SIGTERM');

  const exit = await handle.exit;

  expect(ctx.agent.input).toStrictEqual(['signal:15']);
  expect(exit).toStrictEqual({ code: null, signal: 'SIGTERM' });
});

test('#openExec rejects with RESTARTING when impd closes the session for a restart', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['wait']);

  await handle.started;

  ctx.impd.api.closeExecSessions();

  expect(handle.exit).rejects.toMatchObject({ code: 'RESTARTING' });
});

test('#openExec ends the session and its streams on close', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['wait']);

  await handle.started;

  handle.close();

  const rest = await handle.stdout.getReader().read();

  expect(handle.exit).rejects.toMatchObject({ code: 'CLOSED' });
  expect(rest.done).toBeTrue();
});

test('#openExec ends the session on an abort once the command runs', async () => {
  const ctx = await setupTest();

  const abort = new AbortController();

  const handle = await ctx.client.openExec('dev', ['wait'], { signal: abort.signal });

  await handle.started;

  abort.abort();

  expect(handle.exit).rejects.toMatchObject({ code: 'CLOSED' });
});

test('#openExec rejects with an AbortError for an abort during the connect', async () => {
  const ctx = await setupTest();

  const abort = new AbortController();

  const handle = await ctx.client.openExec('dev', ['wait'], { signal: abort.signal });

  abort.abort();

  const rest = await handle.stdout.getReader().read();

  expect(handle.started).rejects.toMatchObject({ name: 'AbortError' });
  expect(handle.exit).rejects.toBe(Bun.peek(handle.started));
  expect(rest.done).toBeTrue();
});

test('#openExec rejects with the reason of an abort during the connect', async () => {
  const ctx = await setupTest();

  const abort = new AbortController();
  const reason = new Error('gave up');

  const handle = await ctx.client.openExec('dev', ['wait'], { signal: abort.signal });

  abort.abort(reason);

  expect(handle.exit).rejects.toBe(reason);
});

test('#openExec ends a session whose unread output passes maxUnreadBytes', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['big'], { maxUnreadBytes: 64 * 1024 });

  expect(handle.exit).rejects.toBeInstanceOf(ExecError);
  expect(handle.exit).rejects.toMatchObject({ code: 'OUTPUT_OVERFLOW' });
});

test('#openExec stops the command after a break out of the output loop and a cancelled stderr', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['tick']);

  const chunks: Uint8Array[] = [];

  for await (const chunk of handle.stdout) {
    chunks.push(chunk);
    break;
  }

  await handle.stderr.cancel();

  await waitFor(() => {
    expect(ctx.agent.closed).toStrictEqual(['tick']);
  });

  expect(chunks).toStrictEqual([new TextEncoder().encode('tick')]);
  expect(handle.exit).rejects.toMatchObject({ code: 'CLOSED' });
});

test('#openExec answers started and exit with the same promise on every read', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['fail']);

  const reads = [handle.started, handle.started, handle.exit, handle.exit];

  await handle.exit;

  expect(reads[0]).toBe(reads[1]);
  expect(reads[2]).toBe(reads[3]);
});

test('#openExec rejects a write after the exit with CLOSED', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['fail']);

  await handle.exit;

  expect(handle.write('late')).rejects.toMatchObject({ code: 'CLOSED' });
});

test('#openExec does nothing when closing the stdin of a command that already exited', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['fail']);

  await handle.exit;

  expect(handle.closeStdin()).resolves.toBeUndefined();
});

test('#openExec rejects a write after the session failed with why it failed', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['wait']);

  await handle.started;

  ctx.impd.api.closeExecSessions();

  await handle.exit.catch(() => null);

  expect(handle.write('late')).rejects.toMatchObject({ code: 'RESTARTING' });
});

test('#openExec resolves a close of the stdin after the session failed', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['wait']);

  await handle.started;

  ctx.impd.api.closeExecSessions();

  await handle.exit.catch(() => null);

  expect(handle.closeStdin()).resolves.toBeUndefined();
});

test('#openExec passes a kill grace to the agent and reports that it kills the group', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['wait'], { killGraceMs: 2000 });
  const started = await handle.started;

  handle.close();

  await handle.exit.catch(() => null);

  expect(started.groupKill).toBeTrue();
  expect(ctx.agent.requests).toMatchObject([{ argv: ['wait'], kill_grace_ms: 2000 }]);
});

test('#openExec reports no group kill from an agent from before it', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['old'], { killGraceMs: 2000 });
  const started = await handle.started;

  handle.close();

  await handle.exit.catch(() => null);

  expect(started.groupKill).toBeFalse();
});

test('#openExec reports no group kill without a kill grace', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openExec('dev', ['wait']);
  const started = await handle.started;

  handle.close();

  await handle.exit.catch(() => null);

  expect(started.groupKill).toBeFalse();
});

test("#openExec starts a command that requires the broker with the broker's variables", async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const handle = await ctx.client.openExec('dev', ['fail'], { require: ['broker'] });

  await handle.exit;

  expect(ctx.agent.requests).toMatchObject([
    {
      argv: ['fail'],
      env: expect.toSatisfyAny((entry: string) => entry.startsWith('HTTPS_PROXY=')),
    },
  ]);
});

test('#openExec starts nothing that requires anything on an impd without execRequire', async () => {
  const ctx = await setupTest();

  const older = buildStubImpdBeforeExecRequire((request) => ctx.impd.api.app.handle(request));

  server.use(http.all('http://impd.test/*', (info) => older(info.request)));

  const client = createImpClient({
    url: 'http://impd.test/',
    token: ctx.rootToken,
    connect: (url) => new WebSocket(url.replace('ws://impd.test', ctx.url.replace('http', 'ws'))),
  });

  const handle = await client.openExec('dev', ['tick'], { require: ['broker'] });

  expect(handle.exit).rejects.toBeInstanceOf(ExecError);

  expect(handle.exit).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: { reason: 'impd_outdated' },
  });

  expect(ctx.agent.requests).toStrictEqual([]);
});

test('#openConsole opens a login shell with a tty, and sends ^C as a key', async () => {
  const ctx = await setupTest();
  const shell = await ctx.client.openConsole('dev', { cols: 100, rows: 30 });

  await shell.started;

  shell.resize(120, 40);
  shell.sendSignal('SIGINT');

  const exit = await shell.exit;

  expect(ctx.agent.requests).toMatchObject([
    {
      argv: ['/bin/sh', '-c', CONSOLE_SHELL],
      tty: true,
      env: ['TERM=xterm-256color'],
      cols: 100,
      rows: 30,
    },
  ]);

  expect(ctx.agent.input).toStrictEqual(['resize:120x40', '\u0003']);
  expect(exit).toStrictEqual({ code: null, signal: 'SIGINT' });
});

test('#openConsole starts the session it names and reports it', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openConsole('dev', { session: 'main', cols: 100, rows: 30 });
  const started = await handle.started;

  handle.close();

  await handle.exit.catch(() => null);

  expect(started).toStrictEqual({
    pid: 42,
    session: 'main',
    created: true,
    groupKill: false,
    output: { continuity: 'none' },
  });

  expect(ctx.agent.requests).toMatchObject([{ tty: true, session: 'main', cols: 100, rows: 30 }]);
});

test('#openConsole asks impd for a log of the session it starts', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openConsole('dev', { session: 'main', log: true });

  await handle.started;

  handle.close();

  await handle.exit.catch(() => null);

  expect(ctx.agent.requests).toMatchObject([{ session: 'main', log: true }]);
});

test('#openAttach streams the replay and rejects with DETACHED on a takeover', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openAttach('dev', 'main', { cols: 80, rows: 24 });
  const first = await handle.stdout.getReader().read();

  await handle.write('taken');

  expect(first.value).toStrictEqual(new TextEncoder().encode('replay'));

  expect(ctx.agent.requests).toStrictEqual([
    { op: 'session.attach', session: 'main', cols: 80, rows: 24 },
  ]);

  expect(handle.exit).rejects.toBeInstanceOf(ExecError);
  expect(handle.exit).rejects.toMatchObject({ code: 'DETACHED', data: { reason: 'taken_over' } });
});

test('#openAttach resumes at its place in the output and gives the offset at the exit', async () => {
  const ctx = await setupTest();

  const resumeFrom = { executionGeneration: STUB_GENERATION, offset: 95 };

  const handle = await ctx.client.openAttach('dev', 'counted', { resumeFrom });
  const started = await handle.started;

  const tail = await new Response(handle.stdout).text();

  const exit = await handle.exit;

  expect(ctx.agent.requests).toStrictEqual([
    {
      op: 'session.attach',
      session: 'counted',
      resume_from: { execution_generation: STUB_GENERATION, offset: 95 },
    },
  ]);

  expect(started.output).toStrictEqual({
    continuity: 'offsets',
    bootId: STUB_BOOT_ID,
    executionGeneration: STUB_GENERATION,
    bufferStart: 0,
    end: 100,
    offset: 95,
    prelude: 0,
    coldBoots: expect.toBeArrayOfSize(1),
    resume: { kind: 'exact' },
  });

  expect(tail).toBe('tail!');
  expect(exit).toStrictEqual({ code: 0, signal: null, offset: 100 });
});

test('#openAttach rejects a session that is not there as a NoSessionError without data', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openAttach('dev', 'gone');

  expect(handle.exit).rejects.toBeInstanceOf(NoSessionError);
  expect(handle.exit).rejects.toMatchObject({ code: 'NO_SESSION', data: undefined });
});

test('#openAttach rejects a session that ended as a NoSessionError with its data', async () => {
  const ctx = await setupTest();
  const handle = await ctx.client.openAttach('dev', 'ended');

  expect(handle.exit).rejects.toBeInstanceOf(NoSessionError);

  expect(handle.exit).rejects.toMatchObject({
    data: {
      bootId: STUB_BOOT_ID,
      coldBoots: [{ cause: expect.toBeString() }],
      previous: { executionGeneration: STUB_GENERATION, end: 100, exitCode: 0 },
    },
  });
});

test('#openAttach rejects an attach without a wake to a sleeping imp as an InvalidStateError', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.sleep({ name: 'dev' });

  const handle = await ctx.client.openAttach('dev', 'main', { wake: false });

  expect(handle.exit).rejects.toBeInstanceOf(InvalidStateError);

  expect(handle.exit).rejects.toMatchObject({
    data: { state: 'sleeping', allowed: ['running'], coldBoots: expect.toBeArray() },
  });
});

test('#openAttach rejects a resume past the end as an InvalidResumeError with its data', async () => {
  const ctx = await setupTest();

  const resumeFrom = { executionGeneration: STUB_GENERATION, offset: 101 };

  const handle = await ctx.client.openAttach('dev', 'main', { resumeFrom });

  expect(handle.exit).rejects.toBeInstanceOf(InvalidResumeError);
  expect(handle.exit).rejects.toMatchObject({ data: { end: 100, bufferStart: 0 } });
});
