import { expect, mock, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TUNNEL_WINDOW_BYTES } from '@imp/api';
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
import { startProxy } from './proxy-client';
import { sendLocalRequest } from './test-utils/send-local-request';
import { runCli } from './test-utils/start-cli';
import { startStubTunnel } from './test-utils/start-stub-tunnel';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dataDir = await mkdtemp(join(tmpdir(), 'proxy-client-'));

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
  const owned = stack.move();

  return {
    dataDir,
    impd,
    server,
    url,
    client: createImpClient({ url, token: 'root-token' }),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it relays a half-closed request and its reply on both loopbacks', async () => {
  await using ctx = await setupTest();

  const imp = await ctx.client.imps.create({ name: 'box' });

  const decoder = new TextDecoder();

  // the guest's server behind the agent's dial: it answers once the request
  // is whole, then closes its side
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
      } else if (frames.at(-1)?.type === FRAME_TYPES.stdinEof) {
        const asked = frames
          .filter((frame) => frame.type === FRAME_TYPES.stdin)
          .map((frame) => decoder.decode(frame.payload))
          .join('');

        socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode(`got ${asked}`)));
        socket.end(encodeFrame(FRAME_TYPES.stdoutEof));
      }
    },
  );

  onTestFinished(() => {
    agent.close();
  });

  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 5432 }],
    { writeNotice },
  );

  onTestFinished(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  const replies = [
    await sendLocalRequest('127.0.0.1', port, new TextEncoder().encode('hello')),
    await sendLocalRequest('::1', port, new TextEncoder().encode('hi')),
  ];

  expect(replies).toStrictEqual(['got hello', 'got hi']);

  expect(
    agent.received
      .filter((frame) => frame.type === FRAME_TYPES.request)
      .map((frame) => decodeJsonPayload(frame)),
  ).toStrictEqual([
    { op: 'dial', network: 'tcp', address: '127.0.0.1:5432' },
    { op: 'dial', network: 'tcp', address: '127.0.0.1:5432' },
  ]);

  expect(writeNotice).not.toHaveBeenCalled();
});

test('it holds a large upload at the window while impd holds its acks', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  // the deliberate fault: impd opens the tunnel and never acks a byte
  await using tunnel = startStubTunnel({
    token: 'root-token',
    onMessage: (peer, message) => {
      if (message.type === 'open') {
        peer.send({ type: 'opened' });
      }
    },
    fallback: (request) => ctx.impd.api.app.handle(request),
  });

  const proxy = await startProxy(
    { url: tunnel.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice: () => {} },
  );

  onTestFinished(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  // a client whose upload the test never lets finish
  const upload = connect({ host: '127.0.0.1', port });

  onTestFinished(() => {
    upload.destroy();
  });

  upload.on('error', () => {});
  upload.end(new Uint8Array(4 * TUNNEL_WINDOW_BYTES));

  const sent = await waitFor(() => {
    const bytes = tunnel.received.reduce(
      (total, message) => total + (message.type === 'data' ? message.data.byteLength : 0),
      0,
    );

    expect(bytes).toBeGreaterThan(TUNNEL_WINDOW_BYTES);

    return bytes;
  });

  // the client stops at the read that crossed the window
  expect(sent).toBeLessThan(2 * TUNNEL_WINDOW_BYTES);
});

test('it sends the rest of an upload once impd acks the window', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const size = 4 * TUNNEL_WINDOW_BYTES;

  // impd holds every ack until the client stopped at the window, then acks
  // it all and answers once the upload is whole
  await using tunnel = startStubTunnel({
    token: 'root-token',
    onMessage: (peer, message) => {
      if (message.type === 'open') {
        peer.send({ type: 'opened' });
      } else if (message.type === 'eof') {
        peer.sendBinary(new TextEncoder().encode('done'));
        peer.send({ type: 'eof' });
        peer.close(1000, 'done');
      }
    },
    fallback: (request) => ctx.impd.api.app.handle(request),
  });

  const proxy = await startProxy(
    { url: tunnel.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice: () => {} },
  );

  onTestFinished(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  const reply = sendLocalRequest('127.0.0.1', port, new Uint8Array(size));

  await waitFor(() => {
    expect(tunnel.received).toPartiallyContain({ type: 'data' });
  });

  tunnel.peers[0]?.send({ type: 'ack', bytes: size });

  const replied = await reply;

  const sent = tunnel.received.reduce(
    (total, message) => total + (message.type === 'data' ? message.data.byteLength : 0),
    0,
  );

  expect([replied, sent]).toStrictEqual(['done', size]);
});

test('it fails at once naming a local port in use, before any call to impd', async () => {
  const port = findFreePorts(1).take();
  const busy = createServer();

  onTestFinished(() => {
    busy.close();
  });

  const listening = Promise.withResolvers<void>();

  busy.listen(port, '127.0.0.1', listening.resolve);

  await listening.promise;

  // nothing listens at this impd: a call would fail with another message
  const started = startProxy(
    { url: 'http://127.0.0.1:1', token: 'root-token', host: null },
    'box',
    [{ local: port, remote: 5432 }],
    { writeNotice: () => {} },
  );

  expect(started).rejects.toThrowWithMessage(
    Error,
    new RegExp(
      `^local port ${String(port)} is in use; map another one: imp proxy box \\d+:5432 \\(0:5432 takes any free port\\)$`,
      'u',
    ),
  );
});

test('it fails naming the local port when only its IPv6 loopback is in use', async () => {
  const port = findFreePorts(1).take();
  const busy = createServer();

  onTestFinished(() => {
    busy.close();
  });

  const listening = Promise.withResolvers<void>();

  busy.listen(port, '::1', listening.resolve);

  await listening.promise;

  const started = startProxy(
    { url: 'http://127.0.0.1:1', token: 'root-token', host: null },
    'box',
    [{ local: port, remote: 5432 }],
    { writeNotice: () => {} },
  );

  expect(started).rejects.toThrowWithMessage(
    Error,
    new RegExp(`^local port ${String(port)} is in use; map another one: imp proxy box `, 'u'),
  );
});

test.skipIf(
  process.getuid?.() === 0 ||
    Number(readFileSync('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf8')) <= 1,
)('it fails naming a privileged local port, with one above 1023 to map', () => {
  const started = startProxy(
    { url: 'http://127.0.0.1:1', token: 'root-token', host: null },
    'box',
    [{ local: 1, remote: 80 }],
    { writeNotice: () => {} },
  );

  expect(started).rejects.toThrowWithMessage(
    Error,
    'local port 1 needs privileges; map a port above 1023: imp proxy box 8001:80',
  );
});

test('it rejects an imp that impd does not have, and frees its local port', async () => {
  await using ctx = await setupTest();

  const port = findFreePorts(1).take();

  const started = startProxy(
    { url: ctx.url, token: 'root-token', host: null },
    'nope',
    [{ local: port, remote: 80 }],
    { writeNotice: () => {} },
  );

  expect(started).rejects.toMatchObject({ code: 'NOT_FOUND' });

  const again = createServer();

  onTestFinished(() => {
    again.close();
  });

  const listening = new Promise<void>((resolve, reject) => {
    again.once('error', reject);
    again.listen(port, '127.0.0.1', resolve);
  });

  await expect(listening).toResolve();
});

test('it reports impd’s refusal of a dial and resets the local connection', async () => {
  await using ctx = await setupTest();

  const imp = await ctx.client.imps.create({ name: 'box' });

  // the agent cannot connect to the port in the guest
  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'DIAL_FAILED', message: 'dial tcp 127.0.0.1:9: connection refused' },
      }),
    );
  });

  onTestFinished(() => {
    agent.close();
  });

  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 9 }],
    { writeNotice },
  );

  onTestFinished(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  const reply = sendLocalRequest('127.0.0.1', port, new Uint8Array(1));

  expect(reply).rejects.toMatchObject({ code: 'ECONNRESET' });

  await waitFor(() => {
    expect(writeNotice).toHaveBeenCalledExactlyOnceWith(
      'box:9: DIAL_FAILED: dial tcp 127.0.0.1:9: connection refused',
    );
  });
});

test('it ends only the tunnel whose message from impd is not JSON', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  // the deliberate fault: impd answers the open of port 9 with text that is
  // not JSON; port 80 opens, and answers `ok` once the request is whole
  await using tunnel = startStubTunnel({
    token: 'root-token',
    onMessage: (peer, message) => {
      if (message.type === 'open' && message.port === 9) {
        peer.sendText('not json');
      } else if (message.type === 'open') {
        peer.send({ type: 'opened' });
      } else if (message.type === 'eof') {
        peer.sendBinary(new TextEncoder().encode('ok'));
        peer.send({ type: 'eof' });
        peer.close(1000, 'done');
      }
    },
    fallback: (request) => ctx.impd.api.app.handle(request),
  });

  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: tunnel.url, token: 'root-token', host: null },
    'box',
    [
      { local: 0, remote: 9 },
      { local: 0, remote: 80 },
    ],
    { writeNotice },
  );

  onTestFinished(() => {
    proxy.stop();
  });

  const [junkPort, okPort] = proxy.ports;

  invariant(junkPort);
  invariant(okPort);

  const junk = sendLocalRequest('127.0.0.1', junkPort, new Uint8Array(1));

  expect(junk).rejects.toMatchObject({ code: 'ECONNRESET' });

  const reply = await sendLocalRequest('127.0.0.1', okPort, new TextEncoder().encode('hi'));

  expect(reply).toBe('ok');
  expect(writeNotice).toHaveBeenCalledExactlyOnceWith('box:9: impd broke the tunnel protocol');
});

test('it prints one notice for a burst of connections that cannot reach impd', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const writeNotice = mock<(text: string) => void>();

  // the clock stands still through the burst
  const proxy = await startProxy(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice, now: () => Date.UTC(2026, 0, 1) },
  );

  onTestFinished(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  // impd goes away once the proxy checked the imp
  await ctx.server.stop(true);

  const replies = [
    await sendLocalRequest('127.0.0.1', port, new Uint8Array(1)).catch(() => 'reset'),
    await sendLocalRequest('127.0.0.1', port, new Uint8Array(1)).catch(() => 'reset'),
    await sendLocalRequest('127.0.0.1', port, new Uint8Array(1)).catch(() => 'reset'),
  ];

  expect(replies).toStrictEqual(['reset', 'reset', 'reset']);
  expect(writeNotice).toHaveBeenCalledExactlyOnceWith(`could not reach impd at ${ctx.url}`);
});

test('it prints the notice again once the quiet time passed without a failure', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const writeNotice = mock<(text: string) => void>();
  const clock = { nowMs: Date.UTC(2026, 0, 1) };

  const proxy = await startProxy(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice, now: () => clock.nowMs },
  );

  onTestFinished(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  await ctx.server.stop(true);

  await sendLocalRequest('127.0.0.1', port, new Uint8Array(1)).catch(() => 'reset');

  // the quiet time is 5 s
  clock.nowMs += 5001;

  await sendLocalRequest('127.0.0.1', port, new Uint8Array(1)).catch(() => 'reset');

  expect(writeNotice.mock.calls).toStrictEqual([
    [`could not reach impd at ${ctx.url}`],
    [`could not reach impd at ${ctx.url}`],
  ]);
});

test('it prints the usage error for a proxy with no port and no reverse forward', async () => {
  const result = await runCli({ args: ['proxy', 'box'], env: { IMP_URL: 'http://127.0.0.1:1' } });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: name a port to forward, or a --reverse forward\n',
    code: 2,
  });
});
