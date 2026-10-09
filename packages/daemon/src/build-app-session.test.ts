import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { buildApiListenOptions } from './api-listen-options';
import { loadConfig } from './config';
import { createImpd } from './create-impd';
import { createImage } from './db/images';
import { openDatabase } from './db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from './storage/data-layout';
import { createXfsBackend } from './storage/xfs-backend';
import { buildStubCpuCgroups } from './test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from './test-utils/build-stub-vmm';
import { findFreePorts } from './test-utils/find-free-ports';
import { tryExecSocket } from './test-utils/try-impd-sockets';

// impd's real app on stub VMs, serving an empty dashboard dir, reached in
// process and on a loopback port for its sockets
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'build-app-session-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  // the dashboard's built files; a test writes the shell it reads
  const dashboardDir = join(dataDir, 'dashboard');

  await mkdir(join(dashboardDir, 'assets'), { recursive: true });

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one; impd
  // serves the dashboard from its dir
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    IMP_DASHBOARD_DIR: dashboardDir,
  });

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const impd = await createImpd(config, {
    db,

    // the token a login trades for a session, and the bearer of the API
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

  // as main.ts listens, on a free loopback port: /exec needs a socket
  const server = impd.api.app.listen({
    ...buildApiListenOptions(config),
    port: 0,
    hostname: '127.0.0.1',
  });

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

  return {
    dashboardDir,
    port: String(server.server?.port),
    sendToImpd: (request: Request) => impd.api.app.handle(request),
  };
}

test('it answers a login with the token with a strict session cookie', async () => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'root-token' }),
    }),
  );

  expect(login.status).toBe(204);
  expect(login.headers.get('set-cookie')).toStartWith('imp_session=v2.root.');
  expect(login.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
});

test('it accepts the session from its own page', async () => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'root-token' }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie);

  // what a browser on the dashboard's page sends
  const browser: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: {
        cookie,
        'sec-fetch-site': 'same-origin',
      },
      fetch: (request) => ctx.sendToImpd(request),
    }),
  );

  const imps = await browser.imps.list();

  expect(imps).toStrictEqual([]);
});

test('it answers a login behind TLS with a secure __Host- session cookie', async () => {
  const ctx = await setupTest();

  // the wake proxy's HTTPS listener sets x-forwarded-proto on the bare domain
  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: {
        origin: 'http://impd.test',
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ token: 'root-token' }),
    }),
  );

  expect(login.headers.get('set-cookie')).toStartWith('__Host-imp_session=v2.root.');
  expect(login.headers.get('set-cookie')).toEndWith('; Secure');
});

test('it accepts the __Host- session from its own page', async () => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: {
        origin: 'http://impd.test',
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ token: 'root-token' }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie);

  // what a browser on the dashboard's page sends
  const browser: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: {
        cookie,
        'sec-fetch-site': 'same-origin',
      },
      fetch: (request) => ctx.sendToImpd(request),
    }),
  );

  const imps = await browser.imps.list();

  expect(imps).toStrictEqual([]);
});

test('it clears both cookie names at a logout behind TLS', async () => {
  const ctx = await setupTest();

  const logout = await ctx.sendToImpd(
    new Request('http://impd.test/auth/logout', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'x-forwarded-proto': 'https' },
    }),
  );

  expect(logout.headers.getSetCookie().map((cookie) => cookie.split(';')[0])).toStrictEqual([
    'imp_session=',
    '__Host-imp_session=',
  ]);
});

test('it refuses a login with the wrong token and sets no cookie', async () => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    }),
  );

  expect(login.status).toBe(401);
  expect(login.headers.get('set-cookie')).toBeNull();
});

test('it refuses a login from another origin and sets no cookie', async () => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test:20001', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'root-token' }),
    }),
  );

  expect(login.status).toBe(403);
  expect(login.headers.get('set-cookie')).toBeNull();
});

// what an imp's page on another port of this host can make a browser send:
// a link, a form post and a text/plain fetch, none needing a preflight
test.each([
  ['a link', {}],
  ['a same-site link', { 'sec-fetch-site': 'same-site' }],
])('it refuses %s that carries only the session', async (_label, headers) => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'root-token' }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie);

  const response = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/imps/list?data=%7B%22json%22%3A%7B%7D%7D', {
      method: 'GET',
      headers: { ...headers, cookie },
    }),
  );

  expect(response.status).toBe(401);
});

test.each([
  ['from another origin', { origin: 'http://impd.test:20001' }],
  ['with no origin', {}],
])('it refuses a form post %s that carries only the session', async (_label, headers) => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'root-token' }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie);

  const response = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/imps/list?data=%7B%22json%22%3A%7B%7D%7D', {
      method: 'POST',
      headers: { ...headers, cookie },
      body: new FormData(),
    }),
  );

  expect(response.status).toBe(401);
});

test.each([
  ['from another origin', { origin: 'http://impd.test:20001' }],
  ['with no origin', {}],
])('it refuses a text/plain fetch %s that carries only the session', async (_label, headers) => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'root-token' }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie);

  const response = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/imps/list?data=%7B%22json%22%3A%7B%7D%7D', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'text/plain', cookie },
      body: '{"json":{}}',
    }),
  );

  expect(response.status).toBe(401);
});

test('it refuses an API GET even with the token', async () => {
  const ctx = await setupTest();

  const response = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/imps/list?data=%7B%22json%22%3A%7B%7D%7D', {
      headers: { authorization: 'Bearer root-token' },
    }),
  );

  expect(response.status).toBe(405);
});

test('it refuses a logout from another origin', async () => {
  const ctx = await setupTest();

  const logout = await ctx.sendToImpd(
    new Request('http://impd.test/auth/logout', {
      method: 'POST',
      headers: { origin: 'http://impd.test:20001' },
    }),
  );

  expect(logout.status).toBe(403);
});

test('it clears the cookie at a logout from its own origin', async () => {
  const ctx = await setupTest();

  const logout = await ctx.sendToImpd(
    new Request('http://impd.test/auth/logout', {
      method: 'POST',
      headers: { origin: 'http://impd.test' },
    }),
  );

  expect(logout.status).toBe(204);
  expect(logout.headers.get('set-cookie')).toStartWith('imp_session=; Path=/; Max-Age=0');
});

test('it refuses an /exec socket that carries only the session', async () => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'root-token' }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie);

  const outcome = await tryExecSocket(ctx.port, '', 'dev', {
    cookie,
    origin: `http://127.0.0.1:${ctx.port}`,
  });

  expect(outcome).toBe('rejected');
});

test('it redirects the root to the dashboard', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.dashboardDir, 'index.html'), '<!doctype html><title>imp</title>');

  const response = await ctx.sendToImpd(new Request('http://impd.test/'));

  expect(response.headers.get('location')).toBe('/ui/');
});

test('it answers a dashboard app route with the shell', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.dashboardDir, 'index.html'), '<!doctype html><title>imp</title>');

  const response = await ctx.sendToImpd(new Request('http://impd.test/ui/imps/box'));
  const body = await response.text();

  expect(body).toBe('<!doctype html><title>imp</title>');
});

test('it answers /health beside the dashboard', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.dashboardDir, 'index.html'), '<!doctype html><title>imp</title>');

  const response = await ctx.sendToImpd(new Request('http://impd.test/health'));

  // main.ts marks impd ready once it seeds the default image; nothing here does
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ status: 'ok', ready: false });
});

test('it keeps the API behind its auth beside the dashboard', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.dashboardDir, 'index.html'), '<!doctype html><title>imp</title>');

  const response = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/imps/list', { method: 'POST' }),
  );

  expect(response.status).toBe(401);
});
