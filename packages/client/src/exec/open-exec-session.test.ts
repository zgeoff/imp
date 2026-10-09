import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { http } from 'msw';
import { createImpClient } from '../create-imp-client';
import { buildStubExecAgent } from '../test-utils/build-stub-exec-agent';
import { buildStubImpdBeforeExecRequire } from '../test-utils/build-stub-impd-before-exec-require';
import { startStubImpdSocket } from '../test-utils/start-stub-impd-socket';
import { openExecSession } from './open-exec-session';
import type { ExecSession, ExecStarted } from './open-exec-session';

// impd on stub VMs, listening on a loopback port for /exec, with the imp
// `dev` and the stub agent on its vsock; also served at http://impd.test/
// through the run's MSW server, so a test can answer as an older impd
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // impd boots with a root token, the bearer the test's client sends
  const rootToken = 'root-token';

  const dataDir = await mkdtemp(join(tmpdir(), 'imp-client-session-'));

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

test('it reports a refused ticket with a good token as unauthorized, naming the ticket', async () => {
  const ctx = await setupTest();

  const session = openExecSession({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    ticket: 'used.ticket',
    start: { name: 'dev', argv: ['cat'], tty: false },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url) => new WebSocket(url),
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({ kind: 'unauthorized', ticketRefused: true });
});

test('it reports a refused upgrade that only an error event tells of as unauthorized', async () => {
  const ctx = await setupTest();

  const session = openExecSession({
    baseUrl: ctx.url,
    token: 'not-the-token',
    start: { name: 'dev', argv: ['cat'], tty: false },
    onStarted: () => {},
    onOutput: () => {},

    // Node's WebSocket fires `error` and no `close` for a refused upgrade
    connect: (url) => {
      const socket = new WebSocket(url);

      const listen = socket.addEventListener.bind(socket);

      Object.defineProperty(socket, 'addEventListener', {
        value: (type: string, listener: EventListener) => {
          if (type !== 'close') {
            listen(type, listener);
          }
        },
      });

      return socket;
    },
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({ kind: 'unauthorized' });
});

test('it reads a start that impd answers without output as continuity none', async () => {
  const ctx = await setupTest();

  const started = mock<(info: ExecStarted) => void>();

  const session = openExecSession({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    start: { name: 'dev', argv: ['fail'], tty: false },
    onStarted: started,
    onOutput: () => {},
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
  });

  const outcome = await session.outcome;

  expect(started).toHaveBeenCalledExactlyOnceWith({
    pid: 42,
    session: null,
    created: false,
    groupKill: false,
    output: { continuity: 'none' },
  });

  expect(outcome).toStrictEqual({ kind: 'exit', code: 3, signal: null });
});

test('it asks impd before it sends a start that requires anything', async () => {
  const ctx = await setupTest();

  const calls = mock<(path: string) => void>();
  const older = buildStubImpdBeforeExecRequire((request) => ctx.impd.api.app.handle(request));

  server.use(
    http.all('http://impd.test/*', (info) => {
      calls(new URL(info.request.url).pathname);

      return older(info.request);
    }),
  );

  const session = openExecSession({
    baseUrl: 'http://impd.test',
    token: ctx.rootToken,
    start: { name: 'dev', argv: ['tick'], tty: false, require: ['broker'] },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url, headers) =>
      new WebSocket(url.replace('ws://impd.test', ctx.url.replace('http', 'ws')), {
        headers: { ...headers },
      }),
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message: expect.toInclude('older than 0.30.0'),
    data: { reason: 'impd_outdated', detail: expect.toBeString() },
  });

  expect(calls).toHaveBeenCalledExactlyOnceWith('/rpc/system/info');
  expect(ctx.agent.requests).toStrictEqual([]);
});

test('it sends a resize made while the start waits on impd after the start', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const held: { session: ExecSession | null } = { session: null };

  // the resize lands after the socket opened, while impd answers the check
  server.use(
    http.post('http://impd.test/rpc/system/info', (info) => {
      const request = info.request;

      held.session?.resize(100, 40);

      return ctx.impd.api.app.handle(request);
    }),
  );

  held.session = openExecSession({
    baseUrl: 'http://impd.test',
    token: ctx.rootToken,
    start: { name: 'dev', argv: ['wait'], tty: false, require: ['broker'] },

    // the agent records a resize only once its command started
    onStarted: () => {
      held.session?.sendSignal('SIGTERM');
    },
    onOutput: () => {},
    connect: (url, headers) =>
      new WebSocket(url.replace('ws://impd.test', ctx.url.replace('http', 'ws')), {
        headers: { ...headers },
      }),
  });

  const outcome = await held.session.outcome;

  expect(outcome).toStrictEqual({ kind: 'exit', code: null, signal: 'SIGTERM' });
  expect(ctx.agent.input).toStrictEqual(['resize:100x40', 'signal:15']);
});

test('it counts stdin held while the start waits on impd toward backpressure', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const held: { session: ExecSession | null } = { session: null };
  const seen = { accepted: true, drainedDuringCheck: true };

  // more than the high-water mark lands while impd answers the check
  server.use(
    http.post('http://impd.test/rpc/system/info', async (info) => {
      const request = info.request;
      const session = held.session;

      seen.accepted = session?.sendStdin(new Uint8Array(1_048_577)) ?? true;

      const draining = session?.waitForDrain() ?? Promise.resolve();

      const response = await ctx.impd.api.app.handle(request);

      seen.drainedDuringCheck = Bun.peek.status(draining) !== 'pending';

      return response;
    }),
  );

  held.session = openExecSession({
    baseUrl: 'http://impd.test',
    token: ctx.rootToken,
    start: { name: 'dev', argv: ['fail'], tty: false, require: ['broker'] },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url, headers) =>
      new WebSocket(url.replace('ws://impd.test', ctx.url.replace('http', 'ws')), {
        headers: { ...headers },
      }),
  });

  const outcome = await held.session.outcome;

  expect(seen.accepted).toBeFalse();
  expect(seen.drainedDuringCheck).toBeFalse();
  expect(outcome).toStrictEqual({ kind: 'exit', code: 3, signal: null });
});

test('it reports an impd it cannot reach as unreachable', async () => {
  // nothing listens on a free port
  const baseUrl = `http://127.0.0.1:${String(findFreePorts(1).take())}`;

  const session = openExecSession({
    baseUrl,
    token: 'root-token',
    start: { name: 'dev', argv: ['fail'], tty: false },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({ kind: 'unreachable', detail: expect.toBeString() });
});

test('it reports an output handler that throws as a local error with what it threw', async () => {
  const ctx = await setupTest();

  const thrown = new Error('EPIPE');

  const session = openExecSession({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    start: { name: 'dev', argv: ['fail'], tty: false },
    onStarted: () => {},
    onOutput: () => {
      throw thrown;
    },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({ kind: 'local_error', error: thrown });
});

test('it reports a message it does not know as a bad message', async () => {
  const impd = startStubImpdSocket(['{"type":"from-the-future"}']);

  const session = openExecSession({
    baseUrl: impd.url,
    token: null,
    start: { name: 'dev', argv: ['fail'], tty: false },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url) => new WebSocket(url),
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({
    kind: 'bad_message',
    detail: 'unknown message: {"type":"from-the-future"}',
  });
});

test('it reports a message that is not JSON as a bad message', async () => {
  const impd = startStubImpdSocket(['not json']);

  const session = openExecSession({
    baseUrl: impd.url,
    token: null,
    start: { name: 'dev', argv: ['fail'], tty: false },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url) => new WebSocket(url),
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({ kind: 'bad_message', detail: expect.toBeString() });
});
