import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '@zgeoff/imp-client';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { listApiCalls } from '../db/api-audit';
import { createImage } from '../db/images';
import { findImpByName } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { buildImpPaths, buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildQueryGate } from './build-query-gate';
import { buildStubCpuCgroups } from './build-stub-cpu-cgroups';
import { buildStubExecGuest } from './build-stub-exec-guest';
import { buildStubVmm } from './build-stub-vmm';
import { findFreePorts } from './find-free-ports';
import { startStubExecAgent } from './start-stub-exec-agent';
import { buildImpdSocketUrl, tryExecSocket, tryTunnelSocket } from './try-impd-sockets';

// impd's real app on a loopback port, as the clients reach it, and a root
// client for the scenario; an armed `gate` holds impd's next read of the
// imps until the test releases it
async function setupTest() {
  // first, so a held read lets go before impd stops
  const gate = buildQueryGate('imps');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'try-impd-sockets-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const opened = await openDatabase(':memory:');

  stack.defer(() => opened.destroy());

  const db = opened.withPlugin(gate.plugin);

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

  // deferred last, so it stops first, with its sockets
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

  const port = String(server.server?.port);
  const client = createImpClient({ url: `http://127.0.0.1:${port}`, token: 'root-token' });

  return { gate, db, dataDir, port, client, stack };
}

test('#tryExecSocket sends a start for the name and returns the first message', async () => {
  const ctx = await setupTest();
  const reply = await tryExecSocket(ctx.port, '', 'dev-a', { authorization: 'Bearer root-token' });

  expect(reply).toBe(
    '{"type":"error","code":"NOT_FOUND","message":"imp dev-a not found","data":{"kind":"imp","name":"dev-a"}}',
  );
});

test('#tryExecSocket starts dev when no name is given', async () => {
  const ctx = await setupTest();

  const reply = await tryExecSocket(ctx.port, '', undefined, {
    authorization: 'Bearer root-token',
  });

  expect(reply).toBe(
    '{"type":"error","code":"NOT_FOUND","message":"imp dev not found","data":{"kind":"imp","name":"dev"}}',
  );
});

test('#tryExecSocket opens /exec with the query', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const issued = await ctx.client.exec.ticket({ name: 'dev' });
  const reply = await tryExecSocket(ctx.port, `ticket=${issued.ticket}`, 'other');

  // past the upgrade on the ticket, refused at start: it names another imp
  expect(reply).toBe(
    '{"type":"error","code":"FORBIDDEN","message":"the exec ticket is for imp dev"}',
  );
});

test('#tryExecSocket returns rejected when the upgrade is refused', async () => {
  const ctx = await setupTest();
  const reply = await tryExecSocket(ctx.port, '');

  expect(reply).toBe('rejected');
});

test('#tryExecSocket returns closed when the server closes without a message', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'agent', scope: 'exec', imps: ['dev'] });

  ctx.gate.arm();

  const trying = tryExecSocket(ctx.port, '', 'dev', { authorization: `Bearer ${made.secret}` });

  await ctx.gate.reached;

  // impd closes the socket of a token removed while its start waits
  await ctx.client.tokens.delete({ name: 'agent' });

  const reply = await trying;

  expect(reply).toBe('closed');
});

test('#tryTunnelSocket sends an open for the name and returns the first message', async () => {
  const ctx = await setupTest();
  const reply = await tryTunnelSocket(ctx.port, '', { authorization: 'Bearer root-token' }, 'db');

  expect(reply).toBe('{"type":"error","code":"NOT_FOUND","message":"imp db not found"}');
});

test('#tryTunnelSocket opens the tunnel on port 5432', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  await tryTunnelSocket(ctx.port, '', { authorization: 'Bearer root-token' }, 'dev');

  // the audit row lands after the open settles
  const calls = await waitFor(async () => {
    const listed = await listApiCalls(ctx.db, 'dev', 10, null);

    return listed.some((call) => call.procedure.startsWith('tunnel:')) ? listed : null;
  });

  expect(calls).toPartiallyContain({ procedure: 'tunnel:5432' });
});

test('#tryTunnelSocket opens nope when no name is given', async () => {
  const ctx = await setupTest();
  const reply = await tryTunnelSocket(ctx.port, '', { authorization: 'Bearer root-token' });

  expect(reply).toBe('{"type":"error","code":"NOT_FOUND","message":"imp nope not found"}');
});

test('#tryTunnelSocket returns rejected when the upgrade is refused', async () => {
  const ctx = await setupTest();
  const reply = await tryTunnelSocket(ctx.port, '', {});

  expect(reply).toBe('rejected');
});

test('#tryTunnelSocket returns closed when the server closes without a message', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'agent', scope: 'exec', imps: ['dev'] });

  ctx.gate.arm();

  const trying = tryTunnelSocket(ctx.port, '', { authorization: `Bearer ${made.secret}` }, 'dev');

  await ctx.gate.reached;

  // impd closes the socket of a token removed while its open waits
  await ctx.client.tokens.delete({ name: 'agent' });

  const reply = await trying;

  expect(reply).toBe('closed');
});

test('#tryExecSocket starts true without a terminal', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await tryExecSocket(ctx.port, '', 'dev', { authorization: 'Bearer root-token' });

  expect(guest.requests).toStrictEqual([{ argv: ['true'], tty: false }]);
});

test('#buildImpdSocketUrl opens /exec on the loopback port with the query', () => {
  expect(buildImpdSocketUrl('7070', '/exec', 'ticket=abc')).toBe(
    'ws://127.0.0.1:7070/exec?ticket=abc',
  );
});

test('#buildImpdSocketUrl opens /tunnel on the loopback port with the query', () => {
  expect(buildImpdSocketUrl('7070', '/tunnel', 'ticket=abc')).toBe(
    'ws://127.0.0.1:7070/tunnel?ticket=abc',
  );
});
