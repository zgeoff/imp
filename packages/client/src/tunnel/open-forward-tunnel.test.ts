import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { TUNNEL_MAX_FRAME_BYTES, TUNNEL_WINDOW_BYTES } from '@impz/api';
import { FRAME_TYPES, encodeJsonFrame } from '@impz/daemon/src/agent-client/frame-codec';
import { loadConfig } from '@impz/daemon/src/config';
import { createImpd } from '@impz/daemon/src/create-impd';
import { createImage } from '@impz/daemon/src/db/images';
import { openDatabase } from '@impz/daemon/src/db/open-database';
import { readVmIdentity, writeVmIdentity } from '@impz/daemon/src/sleep/vm-identity';
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
import { startStubDialAgent } from '@impz/daemon/src/test-utils/start-stub-dial-agent';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { createImpClient } from '../create-imp-client';
import { openForwardTunnel } from './open-forward-tunnel';
import type { ForwardTunnelEnd } from './open-forward-tunnel';

// impd, booted on stand-ins and listening on a loopback port, and the root
// token's client and config for it
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'exec-client-'));

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

  // impd boots with a root bearer; each test's config sends it
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

  const app = impd.api.app.listen({ port: 0, hostname: '127.0.0.1' });

  stack.defer(async () => {
    await app.stop(true);
  });

  invariant(app.server?.port !== undefined);

  const url = `http://127.0.0.1:${String(app.server.port)}`;

  // the image a test's imp boots from, with a rootfs where its digest names
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(dataDir, image.digest).rootfs, 'rootfs');

  await createImage(db, image);

  return {
    dataDir,
    client: createImpClient({ url, token: rootToken }),
    baseUrl: url,
    token: rootToken,
  };
}

test('it relays bytes and the eof both ways to the port in the imp', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent with port forwarding
  writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

  // the guest's server answers once the request is whole, then closes
  const agent = await startStubDialAgent(paths.vsockSocket, (asked) => `got ${asked}`);

  onTestFinished(() => {
    agent.close();
  });

  const replies: string[] = [];
  const ended = Promise.withResolvers<ForwardTunnelEnd>();
  const onEof = mock<() => void>();

  const tunnel = openForwardTunnel({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    name: 'box',
    port: 5432,
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onOpened: () => {
      tunnel.send(new TextEncoder().encode('hello'));
      tunnel.sendEof();
    },
    onData: (data) => {
      replies.push(new TextDecoder().decode(data));
    },
    onEof,
    onEnd: ended.resolve,
  });

  onTestFinished(() => {
    tunnel.close();
  });

  const end = await ended.promise;

  expect(end).toStrictEqual({ kind: 'done' });
  expect(replies.join('')).toBe('got hello');
  expect(onEof).toHaveBeenCalledOnce();
});

test('it holds bytes past the window until impd acks them', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent with port forwarding
  writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

  // the guest's server takes the dial, then reads nothing, so impd holds
  // its acks once the agent's socket is full
  const agent = await startStubAgent(paths.vsockSocket, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
    socket.pause();
  });

  onTestFinished(() => {
    agent.close();
  });

  const accepted = Promise.withResolvers<boolean>();

  const tunnel = openForwardTunnel({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    name: 'box',
    port: 80,
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onOpened: () => {
      accepted.resolve(tunnel.send(new Uint8Array(4 * TUNNEL_WINDOW_BYTES)));
    },
    onData: () => {},
    onEof: () => {},
    onEnd: () => {},
  });

  onTestFinished(() => {
    tunnel.close();
  });

  const isAccepted = await accepted.promise;

  expect(isAccepted).toBeFalse();

  // past the window by one frame at most, as impd allows
  await waitFor(() => {
    expect(tunnel.countUnackedBytes()).toBeGreaterThan(TUNNEL_WINDOW_BYTES);
  });

  expect(tunnel.countUnackedBytes()).toBeLessThanOrEqual(
    TUNNEL_WINDOW_BYTES + TUNNEL_MAX_FRAME_BYTES,
  );
});

test('it ends as failed with impd’s code when the dial in the imp fails', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent with port forwarding
  writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

  // the agent cannot connect to the port in the guest
  const agent = await startStubAgent(paths.vsockSocket, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'DIAL_FAILED', message: 'dial tcp 127.0.0.1:9: connection refused' },
      }),
    );
  });

  onTestFinished(() => {
    agent.close();
  });

  const ended = Promise.withResolvers<ForwardTunnelEnd>();
  const onOpened = mock<() => void>();

  const tunnel = openForwardTunnel({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    name: 'box',
    port: 9,
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onOpened,
    onData: () => {},
    onEof: () => {},
    onEnd: ended.resolve,
  });

  onTestFinished(() => {
    tunnel.close();
  });

  const end = await ended.promise;

  expect(end).toStrictEqual({
    kind: 'failed',
    code: 'DIAL_FAILED',
    message: 'dial tcp 127.0.0.1:9: connection refused',
  });

  expect(onOpened).not.toHaveBeenCalled();
});

test('it ends as unreachable when nothing answers at impd’s address', async () => {
  const ended = Promise.withResolvers<ForwardTunnelEnd>();

  // nothing listens on a free port
  const tunnel = openForwardTunnel({
    baseUrl: `http://127.0.0.1:${String(findFreePorts(1).take())}`,
    token: 'root-token',
    name: 'box',
    port: 80,
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onOpened: () => {},
    onData: () => {},
    onEof: () => {},
    onEnd: ended.resolve,
  });

  onTestFinished(() => {
    tunnel.close();
  });

  const end = await ended.promise;

  expect(end).toStrictEqual({ kind: 'unreachable' });
});

test('it calls nothing back once the caller closed it', async () => {
  const ctx = await setupTest();

  const onEnd = mock<(end: ForwardTunnelEnd) => void>();
  const closed = Promise.withResolvers<void>();

  const tunnel = openForwardTunnel({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    name: 'box',
    port: 80,
    connect: (url, headers) => {
      const ws = new WebSocket(url, { headers: { ...headers } });

      ws.addEventListener('close', () => {
        closed.resolve();
      });

      return ws;
    },
    onOpened: () => {},
    onData: () => {},
    onEof: () => {},
    onEnd,
  });

  tunnel.close();

  await closed.promise;

  expect(onEnd).not.toHaveBeenCalled();
});
