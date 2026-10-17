import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import type { ImpState } from '@impz/api';
import { FRAME_TYPES, decodeJsonPayload } from '@impz/daemon/src/agent-client/frame-codec';
import { loadConfig } from '@impz/daemon/src/config';
import { createImpd } from '@impz/daemon/src/create-impd';
import { createImage } from '@impz/daemon/src/db/images';
import { openDatabase } from '@impz/daemon/src/db/open-database';
import {
  buildImagePaths,
  buildImpPaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '@impz/daemon/src/storage/data-layout';
import { createXfsBackend } from '@impz/daemon/src/storage/xfs-backend';
import { buildMockNewImage } from '@impz/daemon/src/test-utils/build-mock-new-image';
import { buildStubCpuCgroups } from '@impz/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@impz/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@impz/daemon/src/test-utils/find-free-ports';
import { startStubAgent } from '@impz/daemon/src/test-utils/start-stub-agent';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { createImpClient } from './create-imp-client';
import { parseReverse } from './parse-reverse';
import { startReverseForward } from './reverse-client';
import { buildStubImpStates } from './test-utils/build-stub-imp-states';
import { buildStubListenAgent } from './test-utils/build-stub-listen-agent';
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

  // impd boots with a root bearer; each test reads it back for the forward
  const rootToken = faker.string.alphanumeric(32);

  const impd = await createImpd(config, {
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
  });

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  // the image every imp a test creates boots from, with a rootfs where its
  // digest names
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(dataDir, image.digest).rootfs, 'rootfs');

  await createImage(db, image);

  // the tunnel is a WebSocket, so impd listens as main.ts has it
  const server = impd.api.app.listen({ port: 0, hostname: '127.0.0.1' }).server;

  invariant(server);

  // a stop the test already made is a no-op
  stack.defer(() => server.stop(true));

  const url = `http://127.0.0.1:${String(server.port)}`;

  return {
    // for what the test starts that must stop before impd does
    stack,
    rootToken,
    dataDir,
    impd,
    url,
    client: createImpClient({ url, token: rootToken }),
  };
}

test('it relays a client in the imp to the local unix socket, both ways', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  // the agent listens on a socket it makes, has one client waiting at once,
  // and that client says hello, then closes once the local side did
  const agent = buildStubListenAgent({
    listening: { path: '/run/imp/fwd1.sock' },
    clientSends: 'hello',
  });

  const guest = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    agent.readFrame,
    { stack: ctx.stack },
  );

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
    { url: ctx.url, token: ctx.rootToken, host: null },
    'box',
    parseReverse(`:${join(dir, 'app.sock')}`),
    { writeNotice: () => {} },
  );

  ctx.stack.defer(() => {
    forwarding.stop();
  });

  await waitFor(() => {
    expect(guest.received).toPartiallyContain({ type: FRAME_TYPES.stdinEof });
  });

  const requests = guest.received
    .filter((frame) => frame.type === FRAME_TYPES.request)
    .map((frame) => decodeJsonPayload(frame));

  const sent = guest.received
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
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const agent = buildStubListenAgent({ listening: { port: 9000 } });

  agent.refuseListens({
    code: 'LISTEN_FAILED',
    message: 'the directory /nope does not exist in the imp',
  });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, agent.readFrame, {
    stack: ctx.stack,
  });

  const starting = startReverseForward(
    { url: ctx.url, token: ctx.rootToken, host: null },
    'box',
    parseReverse('/nope/app.sock:9000'),
    { writeNotice: () => {} },
  );

  expect(starting).rejects.toThrowWithMessage(
    Error,
    'reverse forward to localhost:9000: LISTEN_FAILED: the directory /nope does not exist in the imp',
  );
});

test('it rejects a forward whose tunnel cannot reach impd', () => {
  // nothing listens there, so the tunnel closes without a handshake
  const starting = startReverseForward(
    { url: 'http://127.0.0.1:1', token: 'imp-token', host: null },
    'box',
    parseReverse('9000'),
    { writeNotice: () => {} },
  );

  expect(starting).rejects.toThrowWithMessage(
    Error,
    'reverse forward to localhost:9000: could not reach impd',
  );
});

test('it fails the forward when the imp is destroyed while it waits for a wake', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  // the agent listens on port 9000 in the imp for each listen
  const agent = buildStubListenAgent({ listening: { port: 9000 } });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, agent.readFrame, {
    stack: ctx.stack,
  });

  const stub = buildStubWait();
  const watched = mock<(state: ImpState) => void>();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: ctx.rootToken, host: null },
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

  const [listen] = agent.listens;

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

test('it fails the forward with impd’s refusal of the state watch once its token is gone', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });
  const made = await ctx.client.tokens.create({ name: 'runner', scope: 'exec' });

  // the agent listens on port 9000 in the imp for each listen
  const agent = buildStubListenAgent({ listening: { port: 9000 } });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, agent.readFrame, {
    stack: ctx.stack,
  });

  const stub = buildStubWait();
  const writeNotice = mock<(text: string) => void>();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: made.secret, host: null },
    'box',
    parseReverse('9000'),
    { writeNotice, wait: stub.wait },
  );

  ctx.stack.defer(() => {
    forwarding.stop();
  });

  // impd closes the removed token's tunnel, and refuses its watch after the
  // retry time
  await ctx.client.tokens.delete({ name: 'runner' });

  await waitFor(() => {
    expect(stub.calls).toHaveLength(1);
  });

  const [retry] = stub.calls;

  invariant(retry);

  retry.release();

  const failure = await forwarding.failed;

  expect(writeNotice).toHaveBeenCalledExactlyOnceWith(
    'reverse forward to localhost:9000: impd closed it (code 1008); listening again once box runs',
  );

  expect(failure).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
});

test('it waits for an imp that slept to wake before it listens again after a loss', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  // the agent listens on port 9000 in the imp for each listen
  const agent = buildStubListenAgent({ listening: { port: 9000 } });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, agent.readFrame, {
    stack: ctx.stack,
  });

  const stub = buildStubWait();
  const watched = mock<(state: ImpState) => void>();
  const writeNotice = mock<(text: string) => void>();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: ctx.rootToken, host: null },
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

  const [listen] = agent.listens;

  invariant(listen);

  await ctx.client.imps.sleep({ name: 'box' });

  // the sleep ended the listener in the imp
  listen.end();

  await waitFor(() => {
    expect(watched).toHaveBeenCalledExactlyOnceWith('sleeping');
  });

  const listensWhileAsleep = agent.listens.length;

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
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  // the agent listens on port 9000 in the imp for each listen
  const agent = buildStubListenAgent({ listening: { port: 9000 } });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, agent.readFrame, {
    stack: ctx.stack,
  });

  const stub = buildStubWait();
  const watched = mock<(state: ImpState) => void>();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: ctx.rootToken, host: null },
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

  const [listen] = agent.listens;

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
    expect(agent.listens).toHaveLength(2);
  });

  expect(grace.ms).toBe(30_000);
});

test('it fails the forward for good when the agent refuses the listen after a loss', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  // the agent listens on port 9000 once, then refuses
  const agent = buildStubListenAgent({ listening: { port: 9000 } });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, agent.readFrame, {
    stack: ctx.stack,
  });

  const stub = buildStubWait();
  const watched = mock<(state: ImpState) => void>();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: ctx.rootToken, host: null },
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

  const [listen] = agent.listens;

  invariant(listen);

  agent.refuseListens({ code: 'LISTEN_FAILED', message: 'port 9000 is in use in the imp' });
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
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  // the agent listens on port 9000 in the imp for each listen
  const agent = buildStubListenAgent({ listening: { port: 9000 } });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, agent.readFrame, {
    stack: ctx.stack,
  });

  const stub = buildStubWait();
  const watched = mock<(state: ImpState) => void>();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: ctx.rootToken, host: null },
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

  const [listen] = agent.listens;

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
  expect(agent.listens).toHaveLength(1);
});

test('it fails the forward when the imp’s state watch ends while it waits', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  // the agent listens on port 9000 in the imp for each listen
  const agent = buildStubListenAgent({ listening: { port: 9000 } });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, agent.readFrame, {
    stack: ctx.stack,
  });

  // a watch that ends: impd's own stream opens again instead, so only an
  // injected one reaches this
  const states = buildStubImpStates();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: ctx.rootToken, host: null },
    'box',
    parseReverse('9000'),
    { writeNotice: () => {}, watchImp: states.watchImp, wait: buildStubWait().wait },
  );

  ctx.stack.defer(() => {
    forwarding.stop();
  });

  const [listen] = agent.listens;

  invariant(listen);

  states.end();
  listen.end();

  const failure = await forwarding.failed;

  expect(failure).toStrictEqual(new Error('the event stream ended'));
});

test('it listens again after the retry time when impd closes the tunnel to restart', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  // the agent listens on port 9000 in the imp for each listen
  const agent = buildStubListenAgent({ listening: { port: 9000 } });

  await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, agent.readFrame, {
    stack: ctx.stack,
  });

  const stub = buildStubWait();
  const writeNotice = mock<(text: string) => void>();

  const forwarding = await startReverseForward(
    { url: ctx.url, token: ctx.rootToken, host: null },
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
