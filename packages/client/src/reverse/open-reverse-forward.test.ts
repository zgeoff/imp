import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TUNNEL_CLOSE_RESTARTING } from '@imp/api';
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
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '../create-imp-client';
import { buildStubForwardAgent } from '../test-utils/build-stub-forward-agent';
import { openReverseForward } from './open-reverse-forward';

// impd booted in process on stub VMs and listening on a loopback port, as
// /tunnel needs a real socket, with the imp `box` and the stub agent on its
// vsock
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // impd boots with a root token, the bearer the test's client sends
  const rootToken = 'root-token';

  const dataDir = await mkdtemp(join(tmpdir(), 'imp-client-forward-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  // the image `box` boots
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const vmm = buildStubVmm();

  // an agent with reverse forwards
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

  const url = `http://127.0.0.1:${String(impd.api.app.server?.port)}`;
  const client = createImpClient({ url, token: rootToken });

  // the imp every forward listens in, and its agent
  const box = await client.imps.create({ name: 'box' });

  const agent = buildStubForwardAgent();

  const agentServer = await startStubAgent(
    buildImpPaths(dataDir, box.id).vsockSocket,
    agent.readFrame,
  );

  stack.defer(() => {
    agentServer.close();
  });

  return { impd, url, agent, rootToken };
}

test('it listens where impd answers', async () => {
  const ctx = await setupTest();

  const forward = openReverseForward({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    name: 'box',
    guest: { network: 'unix', path: '/tmp/app.sock' },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onConnection: () => {},
  });

  onTestFinished(forward.stop);

  const listening = await forward.listening;

  expect(listening).toStrictEqual({ path: '/tmp/app.sock', port: null });
});

test('it relays a client in the imp that it accepts', async () => {
  const ctx = await setupTest();

  const replies: string[] = [];

  const forward = openReverseForward({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    name: 'box',
    guest: { network: 'unix', path: '/tmp/app.sock' },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onConnection: (accept) => {
      const relay = accept({
        onData: (data) => {
          replies.push(new TextDecoder().decode(data));
        },
        onEof: () => {
          relay.sendEof();
        },
        onClose: () => {},
      });

      relay.send(new TextEncoder().encode('hello'));
    },
  });

  onTestFinished(forward.stop);

  await forward.listening;

  ctx.agent.connect(3);

  await waitFor(() => {
    expect(replies).toStrictEqual(['got hello']);
  });

  expect(ctx.agent.requests).toPartiallyContain({
    op: 'agent.accept',
    listener: 'fwd1',
    connection: 3,
  });
});

test('it ends as lost when its listener in the imp ends', async () => {
  const ctx = await setupTest();

  const forward = openReverseForward({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    name: 'box',
    guest: { network: 'unix', path: '/tmp/app.sock' },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onConnection: () => {},
  });

  onTestFinished(forward.stop);

  await forward.listening;

  ctx.agent.endListeners();

  const end = await forward.ended;

  expect(end).toStrictEqual({ kind: 'lost' });
});

test('it ends as failed with the refusal of a listen impd refused', async () => {
  const ctx = await setupTest();

  ctx.agent.refuseListens({ code: 'LISTEN_FAILED', message: 'address in use' });

  const forward = openReverseForward({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    name: 'box',
    guest: { network: 'unix', path: '/tmp/app.sock' },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onConnection: () => {},
  });

  onTestFinished(forward.stop);

  const end = await forward.ended;

  expect(end).toStrictEqual({ kind: 'failed', code: 'LISTEN_FAILED', message: 'address in use' });
  expect(forward.listening).rejects.toThrowWithMessage(Error, 'address in use');
});

test('it ends as stopped on stop', async () => {
  const ctx = await setupTest();

  const forward = openReverseForward({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    name: 'box',
    guest: { network: 'unix', path: '/tmp/app.sock' },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onConnection: () => {},
  });

  await forward.listening;

  forward.stop();

  const end = await forward.ended;

  expect(end).toStrictEqual({ kind: 'stopped' });
});

test('it ends as closed with the code and reason of a tunnel impd closes as it restarts', async () => {
  const ctx = await setupTest();

  const forward = openReverseForward({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    name: 'box',
    guest: { network: 'unix', path: '/tmp/app.sock' },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onConnection: () => {},
  });

  onTestFinished(forward.stop);

  await forward.listening;

  ctx.impd.api.closeExecSessions();

  const end = await forward.ended;

  expect(end).toStrictEqual({
    kind: 'closed',
    code: TUNNEL_CLOSE_RESTARTING,
    reason: 'impd is restarting',
  });
});
