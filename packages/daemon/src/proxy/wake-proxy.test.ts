import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createImage } from '../db/images';
import { removeImp, updateImpMove } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { PEER_HEADER, createForwardedPeers } from './forwarded-peers';
import { startWakeProxy } from './wake-proxy';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'wake-proxy-'));

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

  // the image every imp here boots: a create needs one
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  return { config, db, impd, stack };
}

test('it ends overlapping listener syncs with no listener for an imp the database lost', async () => {
  const ctx = await setupTest();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  // a listener for `old`, then `old` goes and `new` takes its slot
  const old = await ctx.impd.imps.createImp({ name: 'old' });

  await proxy.syncListeners();

  await removeImp(ctx.db, old.id);

  const fresh = await ctx.impd.imps.createImp({ name: 'new' });

  // the first pass reads `new`, then waits on stopping old's listener; the
  // second reads after `new` is gone too
  const first = proxy.syncListeners();

  await removeImp(ctx.db, fresh.id);

  const second = proxy.syncListeners();

  await Promise.all([first, second]);

  expect(proxy.readImpPort(fresh.id)).toBeNull();
});

test('it stops the listener of an imp the database lost', async () => {
  const ctx = await setupTest();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web' });

  await proxy.syncListeners();

  const port = proxy.readImpPort(imp.id);

  invariant(port);

  await removeImp(ctx.db, imp.id);

  await proxy.syncListeners();

  expect(fetch(`http://127.0.0.1:${String(port)}/`)).rejects.toThrow();
});

test('it keeps the dashboard session cookie from an imp over HTTP', async () => {
  const ctx = await setupTest();

  const cookies: (string | null)[] = [];

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      cookies.push(request.headers.get('cookie'));

      return new Response('ok');
    },
  });

  ctx.stack.defer(() => upstream.stop(true));

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  // the imp's address is the upstream's
  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`, {
    headers: { cookie: 'a=1; imp_session=v1.2.secret; __Host-imp_session=v1.2.secret; b=2' },
  });

  await response.text();

  expect(cookies).toStrictEqual(['a=1; b=2']);
});

test('it keeps the dashboard session cookie from an imp over a WebSocket', async () => {
  const ctx = await setupTest();

  const cookies: (string | null)[] = [];

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, server) => {
      cookies.push(request.headers.get('cookie'));

      return server.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
    },
    websocket: { message: () => {} },
  });

  ctx.stack.defer(() => upstream.stop(true));

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  // the imp's address is the upstream's
  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const socket = new WebSocket(`ws://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`, {
    headers: { cookie: 'a=1; imp_session=v1.2.secret' },
  });

  onTestFinished(() => {
    socket.close();
  });

  const opened = await new Promise<string>((resolve) => {
    socket.addEventListener('open', () => {
      resolve('open');
    });

    socket.addEventListener('error', () => {
      resolve('error');
    });
  });

  expect(opened).toBe('open');
  expect(cookies).toStrictEqual(['a=1']);
});

test('it relays WebSocket messages both ways', async () => {
  const ctx = await setupTest();

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, server) =>
      server.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 }),
    websocket: {
      message: (ws, message) => {
        ws.send(`echo ${String(message)}`);
      },
    },
  });

  ctx.stack.defer(() => upstream.stop(true));

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  // the imp's address is the upstream's
  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const socket = new WebSocket(`ws://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`);

  onTestFinished(() => {
    socket.close();
  });

  const reply = new Promise<string>((resolve) => {
    socket.addEventListener('message', (event) => {
      resolve(String(event.data));
    });
  });

  await new Promise((resolve) => {
    socket.addEventListener('open', resolve);
  });

  socket.send('hello');

  const echoed = await reply;

  expect(echoed).toBe('echo hello');
});

test.each([['/ui/'], ['/ui/assets/app.js'], ['/health'], ['/rpcx']])(
  'it hands the API no peer handle, and strips a forged one, on %s',
  async (path) => {
    const ctx = await setupTest();

    const seen: (string | null)[] = [];

    // impd's API, as far as the proxy can tell
    const api = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        seen.push(request.headers.get(PEER_HEADER));

        return new Response('ok');
      },
    });

    ctx.stack.defer(() => api.stop(true));

    const register = mock(() => 'handle');

    const proxy = startWakeProxy({
      config: { ...ctx.config, apiPort: api.port ?? 0 },
      db: ctx.db,
      imps: ctx.impd.imps,
      log: () => {},
      peers: { register, take: () => null },
      ports: { proxy: 0, slot: () => 0 },
    });

    ctx.stack.defer(() => proxy.stop());

    const apex = proxy.startListener({
      port: 0,
      hostname: '127.0.0.1',
      route: () => ({ kind: 'api' }),
    });

    ctx.stack.defer(() => apex.stop(true));

    const response = await fetch(`http://127.0.0.1:${String(apex.port)}${path}`, {
      headers: { [PEER_HEADER]: 'forged' },
    });

    await response.text();

    expect(seen).toStrictEqual([null]);
    expect(register).not.toHaveBeenCalled();
  },
);

test('it hands the API a peer handle for the client’s address on a path that resolves a caller', async () => {
  const ctx = await setupTest();

  const seen: (string | null)[] = [];

  // impd's API, as far as the proxy can tell
  const api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      seen.push(request.headers.get(PEER_HEADER));

      return new Response('ok');
    },
  });

  ctx.stack.defer(() => api.stop(true));

  const register = mock<(address: string) => string>(() => 'handle');

  const proxy = startWakeProxy({
    config: { ...ctx.config, apiPort: api.port ?? 0 },
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: { register, take: () => null },
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const apex = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => apex.stop(true));

  const response = await fetch(`http://127.0.0.1:${String(apex.port)}/rpc/system/info`, {
    method: 'POST',
    headers: { [PEER_HEADER]: 'forged' },
  });

  await response.text();

  expect(seen).toStrictEqual(['handle']);
  expect(register).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/127\.0\.0\.1$/v));
});

// A streamed build (docs/guides/images.md#build-an-image) lives on its
// progress lines: the proxy in front of the API must pass each one on as it
// comes, not hold the body until it ends.
test('it passes the first line of a streamed API answer on while the API holds the next', async () => {
  const ctx = await setupTest();

  const second = Promise.withResolvers<void>();

  onTestFinished(() => {
    second.resolve();
  });

  const api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => {
      const body = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          controller.enqueue(new TextEncoder().encode('first\n'));

          await second.promise;

          controller.enqueue(new TextEncoder().encode('second\n'));
          controller.close();
        },
      });

      return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
    },
  });

  ctx.stack.defer(() => api.stop(true));

  const proxy = startWakeProxy({
    config: { ...ctx.config, apiPort: api.port ?? 0 },
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const apex = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => apex.stop(true));

  const response = await fetch(`http://127.0.0.1:${String(apex.port)}/images/build`, {
    method: 'POST',
    body: 'tar',
  });

  invariant(response.body);

  const lines = response.body.pipeThrough(new TextDecoderStream()).getReader();

  const first = await lines.read();

  expect(first.value).toBe('first\n');
});

test('it passes the rest of a streamed API answer on once the API sends it', async () => {
  const ctx = await setupTest();

  const second = Promise.withResolvers<void>();

  const api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => {
      const body = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          controller.enqueue(new TextEncoder().encode('first\n'));

          await second.promise;

          controller.enqueue(new TextEncoder().encode('second\n'));
          controller.close();
        },
      });

      return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
    },
  });

  ctx.stack.defer(() => api.stop(true));

  const proxy = startWakeProxy({
    config: { ...ctx.config, apiPort: api.port ?? 0 },
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const apex = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => apex.stop(true));

  const response = await fetch(`http://127.0.0.1:${String(apex.port)}/images/build`, {
    method: 'POST',
    body: 'tar',
  });

  second.resolve();

  const body = await response.text();

  expect(body).toBe('first\nsecond\n');
});

// What `tailscale serve` sends for a per-imp name (docs/guides/tailscale.md):
// the service's Host, its own forwarding headers and the member's login. On
// the imp's own port every one goes to the imp, never to impd's API.
test.each([['box.tail1234.ts.net'], ['imp.example.com'], ['imp.tail1234.ts.net']])(
  'it sends a request on an imp’s port to the imp, not the API, for Host %s',
  async (host) => {
    const ctx = await setupTest();

    const toApi = mock();

    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => new Response(`imp got ${request.headers.get('host') ?? ''}`),
    });

    ctx.stack.defer(() => upstream.stop(true));

    const api = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        toApi();

        return new Response('api');
      },
    });

    ctx.stack.defer(() => api.stop(true));

    const proxy = startWakeProxy({
      config: { ...ctx.config, apiPort: api.port ?? 0 },
      db: ctx.db,
      imps: ctx.impd.imps,
      log: () => {},
      peers: createForwardedPeers(Date.now),
      ports: { proxy: 0, slot: () => 0 },
    });

    ctx.stack.defer(() => proxy.stop());

    const imp = await ctx.impd.imps.createImp({ name: 'box', httpPort: upstream.port });

    // the imp's address is the upstream's
    await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
    await proxy.syncListeners();

    const response = await fetch(
      `http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/rpc/system/info`,
      { method: 'POST', headers: { host } },
    );

    const body = await response.text();

    expect(body).toBe(`imp got ${host}`);
    expect(toApi).not.toHaveBeenCalled();
  },
);

test('it passes tailscale serve’s headers on to the imp, with the session and peer handle stripped', async () => {
  const ctx = await setupTest();

  const received: Headers[] = [];

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      received.push(request.headers);

      return new Response('imp');
    },
  });

  ctx.stack.defer(() => upstream.stop(true));

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'box', httpPort: upstream.port });

  // the imp's address is the upstream's
  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`, {
    headers: {
      host: 'box.tail1234.ts.net',
      'x-forwarded-for': '100.101.1.2',
      'x-forwarded-proto': 'https',
      'tailscale-user-login': 'alice@example.com',
      cookie: 'a=1; imp_session=v1.2.secret',
      [PEER_HEADER]: 'forged',
    },
  });

  await response.text();

  const [headers] = received;

  invariant(headers);

  expect(headers.get('x-forwarded-host')).toBe('box.tail1234.ts.net');

  expect(headers.get('x-forwarded-for')).toMatch(
    /^100\.101\.1\.2, (?<v4mapped>::ffff:)?127\.0\.0\.1$/v,
  );

  expect(headers.get('tailscale-user-login')).toBe('alice@example.com');
  expect(headers.get('cookie')).toBe('a=1');
  expect(headers.get(PEER_HEADER)).toBeNull();
});

test('it routes the Host-named imp on the proxy port', async () => {
  const ctx = await setupTest();

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('imp'),
  });

  ctx.stack.defer(() => upstream.stop(true));

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  // the imp's address is the upstream's
  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();

  const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/`, {
    headers: { host: 'web.imp.localhost' },
  });

  const body = await response.text();

  expect(body).toBe('imp');
});

test('it answers a Host that names no imp on the proxy port with a 404 that says how', async () => {
  const ctx = await setupTest();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/`, {
    headers: { host: 'localhost' },
  });

  expect(response.status).toBe(404);

  const body = await response.text();

  expect(body).toInclude(`Use http://&lt;imp&gt;.imp.localhost:${String(ctx.config.proxyPort)}/.`);
});

test('it answers an imp that does not exist with a 404 that names it', async () => {
  const ctx = await setupTest();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const response = await fetch(`http://127.0.0.1:${String(proxy.port)}/`, {
    headers: { host: 'nope.imp.localhost' },
  });

  expect(response.status).toBe(404);

  const body = await response.text();

  expect(body).toInclude('There is no imp named nope.');
});

test('it answers an unauthorized route with a 401 and its challenge', async () => {
  const ctx = await setupTest();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const listener = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'unauthorized', challenge: 'Bearer realm="web", charset="UTF-8"' }),
  });

  ctx.stack.defer(() => listener.stop(true));

  const response = await fetch(`http://127.0.0.1:${String(listener.port)}/`);

  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toBe('Bearer realm="web", charset="UTF-8"');
});

test('it answers a limited route with a 429 and its Retry-After', async () => {
  const ctx = await setupTest();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const listener = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'limited', detail: 'Too many open requests.', retryAfterS: 7 }),
  });

  ctx.stack.defer(() => listener.stop(true));

  const response = await fetch(`http://127.0.0.1:${String(listener.port)}/`);

  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('7');
});

test('it wakes a sleeping imp and says how long the wake took', async () => {
  const ctx = await setupTest();

  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('imp'),
  });

  ctx.stack.defer(() => upstream.stop(true));

  const logs: string[] = [];

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: (message) => {
      logs.push(message);
    },
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  // the imp's address is the upstream's
  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await ctx.impd.imps.sleepImp('web');
  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/a`);

  await response.text();

  expect(response.headers.get('x-imp-wake-ms')).toMatch(/^\d+$/v);

  expect(logs).toContain(
    `impd: proxy: web woke in ${String(response.headers.get('x-imp-wake-ms'))}ms for GET /a`,
  );
});

test('it stops the request to the imp when the client goes away', async () => {
  const ctx = await setupTest();

  const reached = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<void>();

  onTestFinished(() => {
    aborted.resolve();
  });

  // answers only once the request is aborted
  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      request.signal.addEventListener('abort', () => {
        aborted.resolve();
      });

      reached.resolve(request.signal);

      await aborted.promise;

      return new Response('late');
    },
  });

  ctx.stack.defer(() => upstream.stop(true));

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: upstream.port });

  // the imp's address is the upstream's
  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const client = new AbortController();

  const url = `http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/slow`;
  const pending = Promise.allSettled([fetch(url, { signal: client.signal })]);

  const upstreamSignal = await reached.promise;

  client.abort();

  await waitFor(() => {
    expect(upstreamSignal.aborted).toBeTrue();
  });

  const settled = await pending;

  expect(settled).toStrictEqual([
    {
      status: 'rejected',
      reason: expect.toSatisfy(
        (reason: unknown) => reason instanceof Error && reason.name === 'AbortError',
      ),
    },
  ]);
});

test('it answers a 502 that names the port when nothing answers on the imp’s HTTP port', async () => {
  const ctx = await setupTest();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  // nothing listens on port 1 of loopback
  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: 1 });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`);

  expect(response.status).toBe(502);

  const body = await response.text();

  expect(body).toInclude('web is awake, but nothing answered on port 1');
});

test('it answers a 502 when the imp’s WebSocket cannot be reached', async () => {
  const ctx = await setupTest();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  // nothing listens on port 1 of loopback
  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: 1 });

  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/socket`, {
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',

      // any 16 bytes, base64
      'sec-websocket-key': Buffer.from('imp-test-socket!').toString('base64'),
    },
  });

  expect(response.status).toBe(502);

  const body = await response.text();

  expect(body).toInclude('The WebSocket to ws://127.0.0.1:1/socket failed: connection failed');
});

test('it answers a 502 when the imp’s WebSocket does not open in time', async () => {
  const ctx = await setupTest();

  // takes the connection and never answers the handshake
  const silent = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: () => {} },
  });

  ctx.stack.defer(() => {
    silent.stop(true);
  });

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
    upstreamSocketTimeoutMs: 50,
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web', httpPort: silent.port });

  // the imp's address is the silent listener's
  await ctx.db.updateTable('imps').set({ ip: '127.0.0.1' }).where('id', '=', imp.id).execute();
  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/socket`, {
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',

      // any 16 bytes, base64
      'sec-websocket-key': Buffer.from('imp-test-socket!').toString('base64'),
    },
  });

  expect(response.status).toBe(502);

  const body = await response.text();

  expect(body).toInclude('failed: timed out');
});

test('it warns once about a slot whose port another process holds', async () => {
  const ctx = await setupTest();

  // a process that is not impd holds the port of the imp's slot
  const squatter = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('squatter'),
  });

  ctx.stack.defer(() => squatter.stop(true));

  const logs: string[] = [];

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: (message) => {
      logs.push(message);
    },
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => squatter.port ?? 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  await ctx.impd.imps.createImp({ name: 'first' });
  await proxy.syncListeners();
  await proxy.syncListeners();

  expect(logs.filter((line) => line.includes('cannot listen'))).toStrictEqual([
    expect.toStartWith(`impd: proxy: cannot listen on :${String(squatter.port)} for first: `),
  ]);
});

test('it warns again about a slot that could not listen once a new imp holds it', async () => {
  const ctx = await setupTest();

  // a process that is not impd holds the port of the first imp's slot
  const squatter = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('squatter'),
  });

  ctx.stack.defer(() => squatter.stop(true));

  const first = await ctx.impd.imps.createImp({ name: 'first' });

  const slotPorts = new Map([[first.slot, squatter.port ?? 0]]);

  const logs: string[] = [];

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: (message) => {
      logs.push(message);
    },
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: (slot) => slotPorts.get(slot) ?? 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  await proxy.syncListeners();

  await removeImp(ctx.db, first.id);

  await proxy.syncListeners();
  await ctx.impd.imps.createImp({ name: 'second' });
  await proxy.syncListeners();

  expect(logs.filter((line) => line.includes('cannot listen'))).toStrictEqual([
    expect.toStartWith(`impd: proxy: cannot listen on :${String(squatter.port)} for first: `),
    expect.toStartWith(`impd: proxy: cannot listen on :${String(squatter.port)} for second: `),
  ]);
});

test('it answers a request to a moving imp with a 503 and Retry-After', async () => {
  const ctx = await setupTest();

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await ctx.impd.imps.createImp({ name: 'web' });

  await ctx.impd.imps.stopImp('web');

  await updateImpMove(ctx.db, imp.id, 'sending');

  await proxy.syncListeners();

  const response = await fetch(`http://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`);

  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('30');
});
