import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { findPublicImp } from '../db/exposure';
import { createImage } from '../db/images';
import { findImpByName, updateImpExposure } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { createForwardedPeers } from '../proxy/forwarded-peers';
import { startWakeProxy } from '../proxy/wake-proxy';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildMockCertificate } from '../test-utils/build-mock-certificate';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubHeaderEcho } from '../test-utils/start-stub-header-echo';
import { createHttpsListeners } from './https-listeners';
import { buildCredentialHash, createPublicScope } from './public-auth';
import { createPublicLimits } from './public-limits';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'https-listeners-'));

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

    // the bearer impd's own API checks; no test here calls it
    rootToken: 'root-token',
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),

    // the drive's hash names the drive file above
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

    // Firecracker, the kernel and the CPU as this host reports them, which a
    // snapshot must match to load
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

    // no IPv6 and no tailnet on this host
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: () =>
      Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] }),

    // the VMs, taps, cgroups, firewall and guest memory are the host's: stubs
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
  });

  stack.defer(() => {
    impd.diskUsage.stop();
  });

  // impd's API as the bare domain reaches it, and the upstream the tests'
  // imps point at: it echoes what it got
  const echo = startStubHeaderEcho(stack);

  // the wake proxy the listeners serve through, on ports of its own
  const proxy = startWakeProxy({
    config: { ...config, apiPort: echo.port },
    db,
    imps: impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  stack.defer(() => proxy.stop());

  // the image every imp here boots: a create needs one
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  return { db, impd, stack, echo, proxy };
}

test('it listens on nothing before the first certificate', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  expect(listeners.readPorts()).toStrictEqual({ https: null, http: null });
});

test('it sends the bare domain to the API over https', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/health`, {
    headers: { host: 'imp.test' },
    tls: { rejectUnauthorized: false },
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    path: '/health',
    proto: 'https',
    host: 'imp.test',
    cookie: null,
    authorization: null,
    forwardedFor: '127.0.0.1',
    forwarded: null,
    realIp: null,
    forwardedHost: 'imp.test',
  });
});

test('it takes one label in front of the domain as an imp, even one named like the domain', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  // `imp.imp.test` is the imp named imp, which does not exist
  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: { host: 'imp.imp.test' },
    tls: { rejectUnauthorized: false },
  });

  expect(response.status).toBe(404);

  const body = await response.text();

  expect(body).toInclude('There is no imp named imp.');
});

test('it answers two labels in front of the domain with a 404 that says how', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: { host: 'a.b.imp.test' },
    tls: { rejectUnauthorized: false },
  });

  expect(response.status).toBe(404);

  const body = await response.text();

  expect(body).toInclude('Use https://&lt;imp&gt;.imp.test/.');
});

test('it answers another domain with a 404', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: { host: 'box.imp.localhost' },
    tls: { rejectUnauthorized: false },
  });

  expect(response.status).toBe(404);
});

test('it hands the dashboard session to the API on the bare domain', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: {
      host: 'imp.test',
      cookie: 'a=1; __Host-imp_session=v1.2.secret; imp_session=v1.2.plain',
    },
    tls: { rejectUnauthorized: false },
  });

  const body: unknown = await response.json();

  expect(body).toMatchObject({
    cookie: 'a=1; __Host-imp_session=v1.2.secret; imp_session=v1.2.plain',
  });
});

test('it never hands the dashboard session to an imp', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: ctx.echo.port });

  // the imp's address is the echo's
  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: {
      host: 'web.imp.test',
      cookie: 'a=1; __Host-imp_session=v1.2.secret; imp_session=v1.2.plain',
    },
    tls: { rejectUnauthorized: false },
  });

  const body: unknown = await response.json();

  expect(body).toMatchObject({ host: 'web.imp.test', cookie: 'a=1' });
});

test('it redirects plain http on the domain to https on its port', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const ports = listeners.readPorts();

  const response = await fetch(`http://127.0.0.1:${String(ports.http)}/a/b?c=d`, {
    headers: { host: 'Box.imp.test' },
    redirect: 'manual',
  });

  expect(response.status).toBe(308);

  expect(response.headers.get('location')).toBe(
    `https://box.imp.test:${String(ports.https)}/a/b?c=d`,
  );
});

test('it answers plain http for another domain with a 404', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`http://127.0.0.1:${String(listeners.readPorts().http)}/`, {
    headers: { host: 'evil.example' },
    redirect: 'manual',
  });

  expect(response.status).toBe(404);
});

test('it wakes no imp for plain http on the domain', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());

  await ctx.impd.imps.createImp({ name: 'web' });
  await ctx.impd.imps.sleepImp('web');

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`http://127.0.0.1:${String(listeners.readPorts().http)}/`, {
    headers: { host: 'web.imp.test' },
    redirect: 'manual',
  });

  await response.text();

  const web = await findImpByName(ctx.db, 'web');

  expect(web?.state).toBe('sleeping');
});

test('it serves the first certificate to a new connection', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  const first = await buildMockCertificate({ names: ['first.test', 'imp.test', '*.imp.test'] });

  listeners.setCertificate(first);

  const peer = await new Promise<string>((resolve, reject) => {
    const socket = connect(
      {
        host: '127.0.0.1',
        port: listeners.readPorts().https ?? 0,
        servername: 'box.imp.test',
        rejectUnauthorized: false,
      },
      () => {
        resolve(String(socket.getPeerCertificate().subject.CN));

        socket.end();
      },
    );

    socket.on('error', reject);
  });

  expect(peer).toBe('first.test');
});

test('it serves a new certificate to every new connection once it is set', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  const first = await buildMockCertificate({ names: ['first.test', 'imp.test', '*.imp.test'] });

  listeners.setCertificate(first);

  const second = await buildMockCertificate({ names: ['second.test', 'imp.test', '*.imp.test'] });

  listeners.setCertificate(second);

  // SO_REUSEPORT would spread new connections over both listeners if the
  // old one still took any
  const peers = await Array.from({ length: 5 }).reduce<Promise<string[]>>(async (previous) => {
    const names = await previous;

    const name = await new Promise<string>((resolve, reject) => {
      const socket = connect(
        {
          host: '127.0.0.1',
          port: listeners.readPorts().https ?? 0,
          servername: 'box.imp.test',
          rejectUnauthorized: false,
        },
        () => {
          resolve(String(socket.getPeerCertificate().subject.CN));

          socket.end();
        },
      );

      socket.on('error', reject);
    });

    return [...names, name];
  }, Promise.resolve([]));

  expect(peers).toStrictEqual(Array.from({ length: 5 }, () => 'second.test'));
});

test('it keeps an open WebSocket up across a new certificate', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  const first = await buildMockCertificate({ names: ['first.test', 'imp.test', '*.imp.test'] });

  listeners.setCertificate(first);

  const socket = new WebSocket(`wss://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: { host: 'imp.test' },
    tls: { rejectUnauthorized: false },
  });

  onTestFinished(() => {
    socket.close();
  });

  const reply = new Promise<string>((resolve) => {
    socket.addEventListener('message', (event) => {
      resolve(String(event.data));
    });
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });

  const second = await buildMockCertificate({ names: ['second.test', 'imp.test', '*.imp.test'] });

  listeners.setCertificate(second);
  socket.send('still here');

  const echoed = await reply;

  expect(echoed).toBe('still here');
});

test('it stops serving an address that goes away', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const port = listeners.readPorts().https;

  invariant(port);

  listeners.setAddresses([]);

  await waitFor(() => {
    expect(
      fetch(`https://127.0.0.1:${String(port)}/`, {
        headers: { host: 'imp.test' },
        tls: { rejectUnauthorized: false },
      }),
    ).rejects.toThrow();
  });
});

test('it logs an address it cannot bind once', async () => {
  const ctx = await setupTest();

  // a process that is not impd holds the HTTPS port on loopback
  const squatter = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });

  ctx.stack.defer(() => squatter.stop(true));

  const logs: string[] = [];

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: squatter.port ?? 0,
    httpPort: 0,
    log: (message) => {
      logs.push(message);
    },
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);
  listeners.setAddresses(['127.0.0.1']);
  listeners.setAddresses(['127.0.0.1']);

  expect(logs.filter((line) => line.includes('cannot listen'))).toStrictEqual([
    expect.toStartWith(`impd: https: cannot listen on 127.0.0.1:${String(squatter.port)}: `),
  ]);
});

test('it binds an address it could not bind once the port is free, and says so', async () => {
  const ctx = await setupTest();

  // a process that is not impd holds the HTTPS port on loopback, for a while
  const squatter = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });

  ctx.stack.defer(() => squatter.stop(true));

  const port = squatter.port ?? 0;
  const logs: string[] = [];

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: port,
    httpPort: 0,
    log: (message) => {
      logs.push(message);
    },
    scope: { kind: 'tailnet' },
  });

  ctx.stack.defer(() => listeners.stop());

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);
  listeners.setAddresses(['127.0.0.1']);

  await squatter.stop(true);

  listeners.setAddresses(['127.0.0.1']);

  expect(logs).toContain(`impd: https: listening on 127.0.0.1:${String(port)}`);
});

test.each([['web.imp.test'], ['WEB.imp.test.'], ['web.imp.test:443']])(
  'it answers a tailnet-only imp on the public listener with the 404 for no imp, for Host %s',
  async (host) => {
    const ctx = await setupTest();

    const listeners = createHttpsListeners({
      proxy: ctx.proxy,
      domain: 'imp.test',
      httpsPort: 0,
      httpPort: 0,
      log: () => {},
      scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
    });

    ctx.stack.defer(() => listeners.stop());

    await ctx.impd.imps.createImp({ name: 'web' });

    listeners.setAddresses(['127.0.0.1']);

    const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

    listeners.setCertificate(certificate);

    const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
      headers: { host },
      tls: { rejectUnauthorized: false },
    });

    expect(response.status).toBe(404);

    const body = await response.text();

    expect(body).toInclude('No public imp here.');
  },
);

test('it answers an imp that does not exist on the public listener with the same 404', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: { host: 'nope.imp.test' },
    tls: { rejectUnauthorized: false },
  });

  expect(response.status).toBe(404);

  const body = await response.text();

  expect(body).toInclude('No public imp here.');
});

test('it answers the bare domain on the public listener with the 404 for no imp', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());
  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: { host: 'imp.test' },
    tls: { rejectUnauthorized: false },
  });

  expect(response.status).toBe(404);

  const body = await response.text();

  expect(body).toInclude('No public imp here.');
});

test('it answers plain http for a tailnet-only imp on the public listener with a 404', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());

  await ctx.impd.imps.createImp({ name: 'web' });

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`http://127.0.0.1:${String(listeners.readPorts().http)}/`, {
    headers: { host: 'web.imp.test' },
    redirect: 'manual',
  });

  expect(response.status).toBe(404);
});

test('it wakes no tailnet-only imp for a request on the public listener', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());

  await ctx.impd.imps.createImp({ name: 'web' });
  await ctx.impd.imps.sleepImp('web');

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: { host: 'web.imp.test' },
    tls: { rejectUnauthorized: false },
  });

  await response.text();

  const web = await findImpByName(ctx.db, 'web');

  expect(web?.state).toBe('sleeping');
});

test('it serves a public imp without auth on the public listener', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: ctx.echo.port });

  // the imp's address is the echo's
  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();

  await updateImpExposure(ctx.db, imp.id, { auth: 'none', user: null, hash: null });

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/x`, {
    headers: { host: 'web.imp.test' },
    tls: { rejectUnauthorized: false },
  });

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    path: '/x',
    proto: 'https',
    host: 'web.imp.test',
    cookie: null,
    authorization: null,
    forwardedFor: '127.0.0.1',
    forwarded: null,
    realIp: null,
    forwardedHost: 'web.imp.test',
  });
});

test('it redirects plain http for a public imp to port 443', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web' });

  await updateImpExposure(ctx.db, imp.id, { auth: 'none', user: null, hash: null });

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`http://127.0.0.1:${String(listeners.readPorts().http)}/a?b=c`, {
    headers: { host: 'web.imp.test' },
    redirect: 'manual',
  });

  expect(response.status).toBe(308);
  expect(response.headers.get('location')).toBe('https://web.imp.test/a?b=c');
});

test.each([
  ['no credential', null],
  ['a wrong token', 'Bearer wrong'],
  ['the token as basic auth', `Basic ${Buffer.from('secret-credential').toString('base64')}`],
])('it asks a token imp’s caller for the token, given %s', async (_label, authorization) => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web' });

  await updateImpExposure(ctx.db, imp.id, {
    auth: 'token',
    user: null,
    hash: buildCredentialHash('secret-credential'),
  });

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: { host: 'web.imp.test', ...(authorization !== null && { authorization }) },
    tls: { rejectUnauthorized: false },
  });

  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toBe('Bearer realm="web", charset="UTF-8"');
});

test('it wakes no token imp for a request without its token', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web' });

  await updateImpExposure(ctx.db, imp.id, {
    auth: 'token',
    user: null,
    hash: buildCredentialHash('secret-credential'),
  });

  await ctx.impd.imps.sleepImp('web');

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: { host: 'web.imp.test', authorization: 'Bearer wrong' },
    tls: { rejectUnauthorized: false },
  });

  await response.text();

  const web = await findImpByName(ctx.db, 'web');

  expect(web?.state).toBe('sleeping');
});

test('it serves a token imp given its token, without passing the token on', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: ctx.echo.port });

  // the imp's address is the echo's
  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();

  await updateImpExposure(ctx.db, imp.id, {
    auth: 'token',
    user: null,
    hash: buildCredentialHash('secret-credential'),
  });

  await ctx.impd.imps.sleepImp('web');

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: { host: 'web.imp.test', authorization: 'Bearer secret-credential' },
    tls: { rejectUnauthorized: false },
  });

  const body: unknown = await response.json();

  expect(body).toMatchObject({ host: 'web.imp.test', authorization: null });
});

test.each([
  ['another user', 'bob:secret-credential'],
  ['a wrong password', 'ann:secret'],
])('it asks a basic auth imp’s caller again, given %s', async (_label, credentials) => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web' });

  await updateImpExposure(ctx.db, imp.id, {
    auth: 'basic',
    user: 'ann',
    hash: buildCredentialHash('secret-credential'),
  });

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: {
      host: 'web.imp.test',
      authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
    },
    tls: { rejectUnauthorized: false },
  });

  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toBe('Basic realm="web", charset="UTF-8"');
});

test('it serves a basic auth imp given its user and password, without passing them on', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: ctx.echo.port });

  // the imp's address is the echo's
  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();

  await updateImpExposure(ctx.db, imp.id, {
    auth: 'basic',
    user: 'ann',
    hash: buildCredentialHash('secret-credential'),
  });

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: {
      host: 'web.imp.test',
      authorization: `Basic ${Buffer.from('ann:secret-credential').toString('base64')}`,
    },
    tls: { rejectUnauthorized: false },
  });

  const body: unknown = await response.json();

  expect(body).toMatchObject({ authorization: null });
});

test('it takes no open slot and no wake for plain http on the public listener', async () => {
  const ctx = await setupTest();

  const limits = createPublicLimits(() => 0);

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), limits),
  });

  ctx.stack.defer(() => listeners.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web' });

  await updateImpExposure(ctx.db, imp.id, { auth: 'none', user: null, hash: null });

  await ctx.impd.imps.sleepImp('web');

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  // more than the 64 open slots and the 10 wakes
  const statuses = await Promise.all(
    Array.from({ length: 100 }, async () => {
      const response = await fetch(`http://127.0.0.1:${String(listeners.readPorts().http)}/`, {
        headers: { host: 'web.imp.test' },
        redirect: 'manual',
      });

      return response.status;
    }),
  );

  const releases = Array.from({ length: 64 }, () => limits.tryOpen(imp.id));
  const wakes = Array.from({ length: 10 }, () => limits.tryWake(imp.id));

  expect(statuses).toSatisfyAll((status: number) => status === 308);
  expect(releases).toSatisfyAll((release: (() => void) | null) => release !== null);
  expect(wakes).toSatisfyAll((isWoken: boolean) => isWoken);
});

test('it answers a WebSocket upgrade without the token with a 401', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web' });

  await updateImpExposure(ctx.db, imp.id, {
    auth: 'token',
    user: null,
    hash: buildCredentialHash('secret-credential'),
  });

  await ctx.impd.imps.sleepImp('web');

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: {
      host: 'web.imp.test',
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',

      // any 16 bytes, base64
      'sec-websocket-key': Buffer.from('imp-test-socket!').toString('base64'),
    },
    tls: { rejectUnauthorized: false },
  });

  await response.text();

  const web = await findImpByName(ctx.db, 'web');

  expect(response.status).toBe(401);
  expect(web?.state).toBe('sleeping');
});

test('it replaces a public client’s forwarding headers with its own', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: ctx.echo.port });

  // the imp's address is the echo's
  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();

  await updateImpExposure(ctx.db, imp.id, { auth: 'none', user: null, hash: null });

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: {
      host: 'web.imp.test',
      'x-forwarded-for': '198.51.100.9',
      forwarded: 'for=198.51.100.9;proto=http',
      'x-real-ip': '198.51.100.9',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
    },
    tls: { rejectUnauthorized: false },
  });

  const body: unknown = await response.json();

  expect(body).toMatchObject({
    forwardedFor: '127.0.0.1',
    forwarded: null,
    realIp: null,
    forwardedHost: 'web.imp.test',
    proto: 'https',
  });
});

test('it names neither the imp’s port nor the error on the public listener when the imp does not answer', async () => {
  const ctx = await setupTest();

  const listeners = createHttpsListeners({
    proxy: ctx.proxy,
    domain: 'imp.test',
    httpsPort: 0,
    httpPort: 0,
    log: () => {},
    scope: createPublicScope((name) => findPublicImp(ctx.db, name), createPublicLimits()),
  });

  ctx.stack.defer(() => listeners.stop());

  // nothing listens on port 1 of loopback
  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: 1 });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();

  await updateImpExposure(ctx.db, imp.id, { auth: 'none', user: null, hash: null });

  listeners.setAddresses(['127.0.0.1']);

  const certificate = await buildMockCertificate({ names: ['imp.test', '*.imp.test'] });

  listeners.setCertificate(certificate);

  const response = await fetch(`https://127.0.0.1:${String(listeners.readPorts().https)}/`, {
    headers: { host: 'web.imp.test' },
    tls: { rejectUnauthorized: false },
  });

  const page = await response.text();

  expect(response.status).toBe(502);
  expect(page).toInclude('This site did not answer.');
  expect(page).not.toInclude('port 1');
});
