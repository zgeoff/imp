import { expect, mock, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TUNNEL_CLOSE_LOST,
  TUNNEL_CLOSE_PROTOCOL,
  TUNNEL_CLOSE_RESTARTING,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_WINDOW_BYTES,
} from '@imp/api';
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
import { formatTunnelClose, readTunnelServerMessage, startProxy } from './proxy-client';
import { sendLocalRequest } from './test-utils/send-local-request';
import { runCli } from './test-utils/start-cli';
import { startStubTunnelFaultProxy } from './test-utils/start-stub-tunnel-fault-proxy';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

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

  return {
    // for what the test starts that must stop before impd does
    stack,
    dataDir,
    impd,
    server,
    url,
    client: createImpClient({ url, token: 'root-token' }),
  };
}

test('#startProxy relays a half-closed request and its reply on both loopbacks', async () => {
  const ctx = await setupTest();
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

  ctx.stack.defer(() => {
    agent.close();
  });

  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 5432 }],
    { writeNotice },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  const ipv4Reply = await sendLocalRequest('127.0.0.1', port, new TextEncoder().encode('hello'));
  const ipv6Reply = await sendLocalRequest('::1', port, new TextEncoder().encode('hi'));

  expect(ipv4Reply).toBe('got hello');
  expect(ipv6Reply).toBe('got hi');

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

test('#startProxy stops reading an upload at the window while the guest takes none of it', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  // the guest's server takes the dial, then reads nothing, so impd holds
  // its acks once the agent's socket is full
  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
    socket.pause();
  });

  ctx.stack.defer(() => {
    agent.close();
  });

  const onWindowFull = mock<(unackedBytes: number) => void>();

  const proxy = await startProxy(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice: () => {}, onWindowFull },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  // a client whose upload the guest never lets finish
  const upload = connect({ host: '127.0.0.1', port });

  ctx.stack.defer(() => {
    upload.destroy();
  });

  upload.on('error', () => {});
  upload.end(new Uint8Array(4 * TUNNEL_WINDOW_BYTES));

  await waitFor(() => {
    expect(onWindowFull).toHaveBeenCalled();
  });

  // past the window by one frame at most, as impd allows
  expect(onWindowFull.mock.calls).toSatisfyAll(
    ([unacked]: readonly [number]) =>
      unacked > TUNNEL_WINDOW_BYTES && unacked <= TUNNEL_WINDOW_BYTES + TUNNEL_MAX_FRAME_BYTES,
  );
});

test('#startProxy sends the rest of an upload once the guest takes it again', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const size = 4 * TUNNEL_WINDOW_BYTES;
  const guest = Promise.withResolvers<Socket>();

  // the guest holds the dial unanswered and unread, so the whole upload
  // reaches the client before any ack can; once whole, it answers its size
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.pause();
        guest.resolve(socket);
      } else if (frames.at(-1)?.type === FRAME_TYPES.stdinEof) {
        const bytes = frames
          .filter((frame) => frame.type === FRAME_TYPES.stdin)
          .reduce((total, frame) => total + frame.payload.byteLength, 0);

        const answer = new TextEncoder().encode(`got ${String(bytes)}`);

        socket.write(encodeFrame(FRAME_TYPES.stdout, answer));
        socket.end(encodeFrame(FRAME_TYPES.stdoutEof));
      }
    },
  );

  ctx.stack.defer(() => {
    agent.close();
  });

  const onWindowFull = mock<(unackedBytes: number) => void>();
  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice, onWindowFull },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  const reply = sendLocalRequest('127.0.0.1', port, new Uint8Array(size));

  const dialed = await guest.promise;

  dialed.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));

  await waitFor(() => {
    expect(onWindowFull).toHaveBeenCalled();
  });

  dialed.resume();

  const replied = await reply;

  expect(replied).toBe(`got ${String(size)}`);
  expect(writeNotice).not.toHaveBeenCalled();
});

test('#startProxy fails at once naming a local port in use, before any call to impd', async () => {
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

test('#startProxy fails naming the local port when only its IPv6 loopback is in use', async () => {
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
)('#startProxy fails naming a privileged local port, with one above 1023 to map', () => {
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

test('#startProxy rejects an imp that impd does not have, and frees its local port', async () => {
  const ctx = await setupTest();

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

test('#startProxy reports impd’s refusal of a dial and resets the local connection', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  // the agent cannot connect to the port in the guest
  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'DIAL_FAILED', message: 'dial tcp 127.0.0.1:9: connection refused' },
      }),
    );
  });

  ctx.stack.defer(() => {
    agent.close();
  });

  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 9 }],
    { writeNotice },
  );

  ctx.stack.defer(() => {
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

test('#startProxy ends only the tunnel that gets a message that is not JSON, and closes its local connection', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const decoder = new TextDecoder();

  // the guest's server takes each dial and answers a request once it is whole
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

  ctx.stack.defer(() => {
    agent.close();
  });

  // a fault on the path to impd: impd itself never sends text that is not JSON
  const faulty = startStubTunnelFaultProxy(ctx.stack, ctx.url);
  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: faulty.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 5432 }],
    { writeNotice },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  const broken = connect({ host: '127.0.0.1', port });
  const brokenEnd = Promise.withResolvers<boolean>();

  broken.on('close', brokenEnd.resolve);

  ctx.stack.defer(() => {
    broken.destroy();
  });

  await waitFor(() => {
    expect(faulty.tunnels[0]?.toClient).toContain('{"type":"opened"}');
  });

  const sibling = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  const siblingReply = Promise.withResolvers<string>();
  const siblingChunks: Buffer[] = [];

  sibling.on('data', (chunk: Buffer) => {
    siblingChunks.push(chunk);
  });

  sibling.on('error', siblingReply.reject);

  sibling.on('close', () => {
    siblingReply.resolve(Buffer.concat(siblingChunks).toString());
  });

  ctx.stack.defer(() => {
    sibling.destroy();
  });

  await waitFor(() => {
    expect(faulty.tunnels[1]?.toClient).toContain('{"type":"opened"}');
  });

  faulty.sendText(0, 'not json');

  const hadError = await brokenEnd.promise;

  sibling.end('hello');

  const replied = await siblingReply.promise;

  expect(hadError).toBe(false);
  expect(faulty.tunnels[0]?.isClosed).toBe(true);
  expect(replied).toBe('got hello');
  expect(writeNotice).toHaveBeenCalledExactlyOnceWith('box:5432: impd broke the tunnel protocol');
});

test('#startProxy says impd restarted when impd closes an open tunnel to restart', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box' });

  const dialed = Promise.withResolvers<void>();

  // the guest's server takes the dial and holds the connection open
  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
    dialed.resolve();
  });

  ctx.stack.defer(() => {
    agent.close();
  });

  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  const reply = sendLocalRequest('127.0.0.1', port, new Uint8Array(1));

  await dialed.promise;

  ctx.impd.api.closeExecSessions();

  expect(reply).rejects.toMatchObject({ code: 'ECONNRESET' });

  await waitFor(() => {
    expect(writeNotice).toHaveBeenCalledExactlyOnceWith('box:80: impd restarted');
  });
});

test('#startProxy prints one notice for a burst of connections that cannot reach impd', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const writeNotice = mock<(text: string) => void>();

  // the clock stands still through the burst
  const proxy = await startProxy(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice, now: () => Date.UTC(2026, 0, 1) },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  // impd goes away once the proxy checked the imp
  await ctx.server.stop(true);

  const replies = await Promise.allSettled([
    sendLocalRequest('127.0.0.1', port, new Uint8Array(1)),
    sendLocalRequest('127.0.0.1', port, new Uint8Array(1)),
    sendLocalRequest('127.0.0.1', port, new Uint8Array(1)),
  ]);

  expect(replies.map((reply) => reply.status)).toStrictEqual(['rejected', 'rejected', 'rejected']);
  expect(writeNotice).toHaveBeenCalledExactlyOnceWith(`could not reach impd at ${ctx.url}`);
});

test('#startProxy prints the notice again once the quiet time passed without a failure', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const writeNotice = mock<(text: string) => void>();
  const clock = { nowMs: Date.UTC(2026, 0, 1) };

  const proxy = await startProxy(
    { url: ctx.url, token: 'root-token', host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice, now: () => clock.nowMs },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  await ctx.server.stop(true);
  await Promise.allSettled([sendLocalRequest('127.0.0.1', port, new Uint8Array(1))]);

  // the quiet time is 5 s
  clock.nowMs += 5001;

  await Promise.allSettled([sendLocalRequest('127.0.0.1', port, new Uint8Array(1))]);

  expect(writeNotice.mock.calls).toStrictEqual([
    [`could not reach impd at ${ctx.url}`],
    [`could not reach impd at ${ctx.url}`],
  ]);
});

test('#runProxy prints the usage error for a proxy with no port and no reverse forward', async () => {
  const result = await runCli({ args: ['proxy', 'box'], env: { IMP_URL: 'http://127.0.0.1:1' } });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: name a port to forward, or a --reverse forward\n',
    code: 2,
  });
});

test('#readTunnelServerMessage reads a control message impd sends', () => {
  expect(readTunnelServerMessage('{"type":"ack","bytes":4096}')).toStrictEqual({
    type: 'ack',
    bytes: 4096,
  });
});

test('#readTunnelServerMessage refuses text that is not JSON as a broken protocol', () => {
  expect(readTunnelServerMessage('not json')).toBeNull();
});

test('#readTunnelServerMessage refuses JSON that is no message of the protocol', () => {
  expect(readTunnelServerMessage('{"type":"hello"}')).toBeNull();
});

test.each([
  [TUNNEL_CLOSE_LOST, 'the connection in the imp was lost'],
  [TUNNEL_CLOSE_RESTARTING, 'impd restarted'],
  [TUNNEL_CLOSE_PROTOCOL, 'impd broke the tunnel protocol'],
  [4999, 'impd closed the tunnel (code 4999)'],
])('#formatTunnelClose names close code %d as %s', (code, text) => {
  expect(formatTunnelClose(code)).toBe(text);
});
