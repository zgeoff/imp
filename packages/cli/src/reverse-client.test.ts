import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpState } from '@imp/api';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '@imp/daemon/src/agent-client/frame-codec';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
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
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from './create-imp-client';
import { parseReverse } from './parse-reverse';
import { startReverseForward } from './reverse-client';
import { buildStubImpStates } from './test-utils/build-stub-imp-states';
import { buildStubWait } from './test-utils/build-stub-wait';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'reverse-client-'));

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

  // the system drive impd boots imps with
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  // an agent new enough to dial and listen, which impd checks before each
  vmm.agent.version = '0.18.0';

  const impd = await createImpd(config, {
    db,

    // the bearer the CLI sends
    rootToken: 'root-token',
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
  });

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  // the image every imp a test creates boots from
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  // the tunnel is a WebSocket, so impd listens as main.ts has it
  const server = impd.api.app.listen({ port: 0, hostname: '127.0.0.1' }).server;

  invariant(server);

  // a stop the test already made is a no-op
  stack.defer(() => server.stop(true));

  const url = `http://127.0.0.1:${String(server.port)}`;

  return {
    // for what the test starts that must stop before impd does
    stack,
    dataDir,
    impd,
    url,
    client: createImpClient({ url, token: 'root-token' }),
  };
}

test('it relays a client in the imp to the local unix socket, both ways', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  // the agent listens on a socket it makes, has one client waiting at once,
  // and that client says hello, then closes once the local side did
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request, frames) => {
      const asked: unknown = decodeJsonPayload(request);

      const op: unknown =
        typeof asked === 'object' && asked !== null ? Reflect.get(asked, 'op') : null;

      if (frames.length === 1 && op === 'listen') {
        socket.write(
          encodeJsonFrame(FRAME_TYPES.response, {
            ok: true,
            listener: 'fwd1',
            path: '/run/imp/fwd1.sock',
          }),
        );

        socket.write(encodeJsonFrame(FRAME_TYPES.connection, { id: 1 }));
      } else if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
        socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('hello')));
      } else if (frames.at(-1)?.type === FRAME_TYPES.stdinEof) {
        socket.end(encodeFrame(FRAME_TYPES.stdoutEof));
      }
    },
  );

  ctx.stack.defer(() => {
    agent.close();
  });

  const dir = await mkdtemp(join(tmpdir(), 'reverse-local-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  // the local app: answers each chunk in capitals, then closes
  const app = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('data', (chunk: Buffer) => {
      socket.end(chunk.toString().toUpperCase());
    });
  });

  ctx.stack.defer(() => {
    app.close();
  });

  app.listen(join(dir, 'app.sock'));

  const forwarding = await startReverseForward(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    parseReverse(`:${join(dir, 'app.sock')}`),
    { writeNotice: () => {} },
  );

  ctx.stack.defer(() => {
    forwarding.stop();
  });

  await waitFor(() => {
    expect(agent.received).toPartiallyContain({ type: FRAME_TYPES.stdinEof });
  });

  const requests = agent.received
    .filter((frame) => frame.type === FRAME_TYPES.request)
    .map((frame) => decodeJsonPayload(frame));

  const sent = agent.received
    .filter((frame) => frame.type === FRAME_TYPES.stdin)
    .map((frame) => new TextDecoder().decode(frame.payload))
    .join('');

  expect(forwarding.listening).toStrictEqual({ path: '/run/imp/fwd1.sock', port: null });

  expect(requests).toStrictEqual([
    { op: 'listen', network: 'unix', address: '' },
    { op: 'agent.accept', listener: 'fwd1', connection: 1 },
  ]);

  expect(sent).toBe('HELLO');
});

test('it rejects a listen the agent refuses, with the agent’s code', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'LISTEN_FAILED', message: 'the directory /nope does not exist in the imp' },
      }),
    );
  });

  ctx.stack.defer(() => {
    agent.close();
  });

  const starting = startReverseForward(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    parseReverse('/nope/app.sock:9000'),
    { writeNotice: () => {} },
  );

  expect(starting).rejects.toThrowWithMessage(
    Error,
    'reverse forward to localhost:9000: LISTEN_FAILED: the directory /nope does not exist in the imp',
  );
});

test('it fails the forward when the imp is destroyed while it waits for a wake', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const listens: Socket[] = [];

  // the agent listens on port 9000 in the imp for each listen
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request) => {
      const asked: unknown = decodeJsonPayload(request);

      const op: unknown =
        typeof asked === 'object' && asked !== null ? Reflect.get(asked, 'op') : null;

      // the imp's other agent calls, such as a sleep's, go unanswered
      if (op !== 'listen') {
        socket.end();

        return;
      }

      socket.write(
        encodeJsonFrame(FRAME_TYPES.response, { ok: true, listener: 'fwd1', port: 9000 }),
      );

      listens.push(socket);
    },
  );

  ctx.stack.defer(() => {
    agent.close();
  });

  const stub = buildStubWait();
  const watched = mock<(state: ImpState) => void>();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    parseReverse('9000'),
    {
      writeNotice: () => {},
      wait: stub.wait,
      onWatchedState: watched,
    },
  );

  ctx.stack.defer(() => {
    forwarding.stop();
  });

  const [listen] = listens;

  invariant(listen);

  // the agent ends the listener, as a forced sleep does
  listen.end();

  await waitFor(() => {
    expect(watched).toHaveBeenCalled();
  });

  await ctx.client.imps.destroy({ name: 'box' });

  const failure = await forwarding.failed;

  expect(failure).toStrictEqual(new Error('box was destroyed'));
});

test('it waits for an imp that slept to wake before it listens again after a loss', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const listens: Socket[] = [];

  // the agent listens on port 9000 in the imp for each listen
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request) => {
      const asked: unknown = decodeJsonPayload(request);

      const op: unknown =
        typeof asked === 'object' && asked !== null ? Reflect.get(asked, 'op') : null;

      // the imp's other agent calls, such as a sleep's, go unanswered
      if (op !== 'listen') {
        socket.end();

        return;
      }

      socket.write(
        encodeJsonFrame(FRAME_TYPES.response, { ok: true, listener: 'fwd1', port: 9000 }),
      );

      listens.push(socket);
    },
  );

  ctx.stack.defer(() => {
    agent.close();
  });

  const stub = buildStubWait();
  const watched = mock<(state: ImpState) => void>();
  const writeNotice = mock<(text: string) => void>();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    parseReverse('9000:8080'),
    {
      writeNotice,
      wait: stub.wait,
      onWatchedState: watched,
    },
  );

  ctx.stack.defer(() => {
    forwarding.stop();
  });

  const [listen] = listens;

  invariant(listen);

  await ctx.client.imps.sleep({ name: 'box' });

  // the sleep ended the listener in the imp
  listen.end();

  await waitFor(() => {
    expect(watched).toHaveBeenCalledExactlyOnceWith('sleeping');
  });

  const listensWhileAsleep = listens.length;

  await ctx.client.imps.start({ name: 'box' });

  await waitFor(() => {
    expect(writeNotice).toHaveBeenCalledTimes(2);
  });

  expect(listensWhileAsleep).toBe(1);

  expect(writeNotice.mock.calls).toStrictEqual([
    [
      'reverse forward to localhost:8080: its listener in the imp ended; listening again once box runs',
    ],
    ['forwarding box:9000 -> localhost:8080 again'],
  ]);
});

test('it listens again once the grace passes on an imp that stayed running', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const listens: Socket[] = [];

  // the agent listens on port 9000 in the imp for each listen
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request) => {
      const asked: unknown = decodeJsonPayload(request);

      const op: unknown =
        typeof asked === 'object' && asked !== null ? Reflect.get(asked, 'op') : null;

      // the imp's other agent calls, such as a sleep's, go unanswered
      if (op !== 'listen') {
        socket.end();

        return;
      }

      socket.write(
        encodeJsonFrame(FRAME_TYPES.response, { ok: true, listener: 'fwd1', port: 9000 }),
      );

      listens.push(socket);
    },
  );

  ctx.stack.defer(() => {
    agent.close();
  });

  const stub = buildStubWait();
  const watched = mock<(state: ImpState) => void>();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    parseReverse('9000'),
    {
      writeNotice: () => {},
      wait: stub.wait,
      onWatchedState: watched,
    },
  );

  ctx.stack.defer(() => {
    forwarding.stop();
  });

  const [listen] = listens;

  invariant(listen);

  // the agent ends the listener while the imp runs on
  listen.end();

  await waitFor(() => {
    expect(watched).toHaveBeenCalled();
  });

  const [grace] = stub.calls;

  invariant(grace);

  grace.release();

  await waitFor(() => {
    expect(listens).toHaveLength(2);
  });

  expect(grace.ms).toBe(30_000);
});

test('it fails the forward for good when the agent refuses the listen after a loss', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const listens: Socket[] = [];

  // the agent listens on port 9000 once, then refuses
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request) => {
      const asked: unknown = decodeJsonPayload(request);

      const op: unknown =
        typeof asked === 'object' && asked !== null ? Reflect.get(asked, 'op') : null;

      // the imp's other agent calls, such as a sleep's, go unanswered
      if (op !== 'listen') {
        socket.end();

        return;
      }

      if (listens.length === 0) {
        socket.write(
          encodeJsonFrame(FRAME_TYPES.response, { ok: true, listener: 'fwd1', port: 9000 }),
        );
      } else {
        socket.end(
          encodeJsonFrame(FRAME_TYPES.response, {
            error: { code: 'LISTEN_FAILED', message: 'port 9000 is in use in the imp' },
          }),
        );
      }

      listens.push(socket);
    },
  );

  ctx.stack.defer(() => {
    agent.close();
  });

  const stub = buildStubWait();
  const watched = mock<(state: ImpState) => void>();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    parseReverse('9000'),
    {
      writeNotice: () => {},
      wait: stub.wait,
      onWatchedState: watched,
    },
  );

  ctx.stack.defer(() => {
    forwarding.stop();
  });

  const [listen] = listens;

  invariant(listen);

  listen.end();

  await waitFor(() => {
    expect(watched).toHaveBeenCalled();
  });

  const [grace] = stub.calls;

  invariant(grace);

  grace.release();

  const failure = await forwarding.failed;

  expect(failure).toStrictEqual(
    new Error('reverse forward to localhost:9000: LISTEN_FAILED: port 9000 is in use in the imp'),
  );
});

test('it ends the wait for a wake when the forward stops', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const listens: Socket[] = [];

  // the agent listens on port 9000 in the imp for each listen
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request) => {
      const asked: unknown = decodeJsonPayload(request);

      const op: unknown =
        typeof asked === 'object' && asked !== null ? Reflect.get(asked, 'op') : null;

      // the imp's other agent calls, such as a sleep's, go unanswered
      if (op !== 'listen') {
        socket.end();

        return;
      }

      socket.write(
        encodeJsonFrame(FRAME_TYPES.response, { ok: true, listener: 'fwd1', port: 9000 }),
      );

      listens.push(socket);
    },
  );

  ctx.stack.defer(() => {
    agent.close();
  });

  const stub = buildStubWait();
  const watched = mock<(state: ImpState) => void>();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    parseReverse('9000'),
    {
      writeNotice: () => {},
      wait: stub.wait,
      onWatchedState: watched,
    },
  );

  // a stop the test already made is a no-op
  ctx.stack.defer(() => {
    forwarding.stop();
  });

  const [listen] = listens;

  invariant(listen);

  await ctx.client.imps.sleep({ name: 'box' });

  listen.end();

  await waitFor(() => {
    expect(watched).toHaveBeenCalled();
  });

  forwarding.stop();

  // a second stream of impd's events, which sees the wake when the stopped
  // forward's stream would have: impd sends each change to every stream
  const reading = new AbortController();

  ctx.stack.defer(() => {
    reading.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: reading.signal });

  const reader = events[Symbol.asyncIterator]();
  const seen: unknown[] = [];

  await ctx.client.imps.start({ name: 'box' });

  // each try reads the stream's next event
  await waitFor(async () => {
    const next = await reader.next();

    seen.push(next.value);

    expect(seen).toPartiallyContain({
      ev: 'ImpChanged',
      imp: expect.objectContaining({ state: 'running' }) as unknown,
    });
  });

  const [grace] = stub.calls;

  invariant(grace);

  expect(grace.signal.aborted).toBe(true);
  expect(watched).not.toHaveBeenCalledWith('running');
  expect(listens).toHaveLength(1);
});

test('it fails the forward when the imp’s state watch ends while it waits', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const listens: Socket[] = [];

  // the agent listens on port 9000 in the imp for each listen
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request) => {
      const asked: unknown = decodeJsonPayload(request);

      const op: unknown =
        typeof asked === 'object' && asked !== null ? Reflect.get(asked, 'op') : null;

      // the imp's other agent calls, such as a sleep's, go unanswered
      if (op !== 'listen') {
        socket.end();

        return;
      }

      socket.write(
        encodeJsonFrame(FRAME_TYPES.response, { ok: true, listener: 'fwd1', port: 9000 }),
      );

      listens.push(socket);
    },
  );

  ctx.stack.defer(() => {
    agent.close();
  });

  // a watch that ends: impd's own stream opens again instead, so only an
  // injected one reaches this
  const states = buildStubImpStates();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    parseReverse('9000'),
    { writeNotice: () => {}, watchImp: states.watchImp, wait: buildStubWait().wait },
  );

  ctx.stack.defer(() => {
    forwarding.stop();
  });

  const [listen] = listens;

  invariant(listen);

  states.end();
  listen.end();

  const failure = await forwarding.failed;

  expect(failure).toStrictEqual(new Error('the event stream ended'));
});

test('it listens again after the retry time when impd closes the tunnel to restart', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const listens: Socket[] = [];

  // the agent listens on port 9000 in the imp for each listen
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request) => {
      const asked: unknown = decodeJsonPayload(request);

      const op: unknown =
        typeof asked === 'object' && asked !== null ? Reflect.get(asked, 'op') : null;

      // the imp's other agent calls, such as a sleep's, go unanswered
      if (op !== 'listen') {
        socket.end();

        return;
      }

      socket.write(
        encodeJsonFrame(FRAME_TYPES.response, { ok: true, listener: 'fwd1', port: 9000 }),
      );

      listens.push(socket);
    },
  );

  ctx.stack.defer(() => {
    agent.close();
  });

  const stub = buildStubWait();
  const writeNotice = mock<(text: string) => void>();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    parseReverse('9000'),
    { writeNotice, wait: stub.wait },
  );

  ctx.stack.defer(() => {
    forwarding.stop();
  });

  // impd closes every tunnel as it restarts
  ctx.impd.api.closeExecSessions();

  await waitFor(() => {
    expect(stub.calls).toHaveLength(1);
  });

  const [retry] = stub.calls;

  invariant(retry);

  retry.release();

  await waitFor(() => {
    expect(writeNotice).toHaveBeenCalledTimes(2);
  });

  expect(retry.ms).toBe(2000);

  expect(writeNotice.mock.calls).toStrictEqual([
    [
      'reverse forward to localhost:9000: impd closed it (code 1012); listening again once box runs',
    ],
    ['forwarding box:9000 -> localhost:9000 again'],
  ]);
});
