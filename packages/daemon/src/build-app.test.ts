import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { updateEnv } from '@imp/test-utils/update-env';
import { waitFor } from '@imp/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import packageJson from '../package.json' with { type: 'json' };
import { buildApiListenOptions } from './api-listen-options';
import { loadConfig } from './config';
import { createImpd } from './create-impd';
import { listApiCalls } from './db/api-audit';
import { createImage } from './db/images';
import { findImpByName } from './db/imps';
import { openDatabase } from './db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from './storage/data-layout';
import { createXfsBackend } from './storage/xfs-backend';
import { buildStubCpuCgroups } from './test-utils/build-stub-cpu-cgroups';
import { buildStubDockerCli } from './test-utils/build-stub-docker-cli';
import { buildStubVmm } from './test-utils/build-stub-vmm';
import { findFreePorts } from './test-utils/find-free-ports';
import { tryExecSocket, tryTunnelSocket } from './test-utils/try-impd-sockets';

interface SetupOptions {
  // impd's environment past what every test boots with
  readonly env?: Readonly<Record<string, string>>;
}

// impd's real app on stub VMs, on a loopback port for the sockets, with a
// root client in process, the clock the test steps, the stub VMM and the taps
// impd set up
async function setupTest(options: SetupOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'build-app-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  const config = {
    // the stub VMM runs no jailer and builds no boot template; the resolver
    // binds its port on every address, so each impd takes a free one
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
      ...options.env,
    }),

    // a new disk stays the size of its image, since the clone copies every
    // byte of a template's disk
    defaultDiskBytes: 0,
  };

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  // the clock of holds, budgets and tickets; a test moves it
  const clock = { nowMs: Date.now() };

  // each tap impd set up, by name
  const taps: string[] = [];

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
    now: () => clock.nowMs,

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
    taps: {
      setupTap: (address) => {
        taps.push(address.tap);

        return Promise.resolve();
      },
      removeTap: () => Promise.resolve(),
    },
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

  // as main.ts listens, on a free loopback port: exec and tunnels are sockets
  const server = impd.api.app.listen({
    ...buildApiListenOptions(config),
    port: 0,
    hostname: '127.0.0.1',
  });

  stack.defer(async () => {
    await server.stop(true);
  });

  // the root bearer's client, against impd's own app
  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  return {
    db,
    dataDir,
    impd,
    vmm,
    clock,
    taps,
    client,
    port: String(server.server?.port),
  };
}

test('it serves system.info from config and the database', async () => {
  const ctx = await setupTest();
  const { storage, ...info } = await ctx.client.system.info();

  // the test data dir's own filesystem
  expect(storage.backend).toBe('xfs');
  expect(storage.availableBytes).toBeGreaterThan(0);

  expect(info).toStrictEqual({
    version: packageJson.version,
    ramBudgetMib: 16_384,
    ramUsedMib: 0,
    ramReservedMib: 0,
    ramCommittedMib: 0,
    ramSleepingMib: 0,
    awakeCount: 0,
    impCount: 0,
    sessionCount: 0,
    bootStatus: { coldBoots: 0, outdated: { firecracker: 0, kernel: 0, agent: 0 } },
    firecrackerVersion: 'v1.17.0',
    guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
    systemDrive: { sha256: 'd1'.repeat(32) },
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },

    // the stub cgroup tree has a cpu controller
    cpu: { hostCpus: 8, limitsEnforced: true },
    defaults: { memoryMib: 2048, image: null },
    egress: { isEnforced: true },
    public: null,
    https: null,
    features: {
      sessionOffsets: true,
      leases: true,
      grantableTokens: true,
      tokenUpdate: true,
      secretRebind: true,
      databaseCopy: true,
      imageBuildStream: true,
      imageOpStream: true,
      execRequire: true,
      oauthGrants: true,
      secretFilesGc: true,
      sessionLog: true,
      publicEgress: true,
      oauthSecrets: true,
      secretUpstream: true,
    },
    ksm: null,
  });
});

test('it rejects a request with the wrong token', async () => {
  const ctx = await setupTest();

  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer wrong' },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  expect(client.system.info()).rejects.toMatchObject({ status: 401 });
});

test('it answers 404 for a procedure the API does not have', async () => {
  const ctx = await setupTest();

  const response = await ctx.impd.api.app.handle(
    new Request('http://impd.test/rpc/nope/missing', {
      method: 'POST',
      headers: { authorization: 'Bearer root-token', 'content-type': 'application/json' },
      body: '{}',
    }),
  );

  const body = await response.text();

  expect(response.status).toBe(404);
  expect(body).toBe('not found');
});

test('it refuses an image build without a token', async () => {
  const ctx = await setupTest();

  const response = await ctx.impd.api.app.handle(
    new Request('http://impd.test/images/build', { method: 'POST', body: 'context' }),
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(401);
  expect(body).toStrictEqual({ error: 'unauthorized' });
});

test('it answers a conflict that is not a move without Retry-After', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  const response = await ctx.impd.api.app.handle(
    new Request('http://impd.test/rpc/imps/create', {
      method: 'POST',
      headers: { authorization: 'Bearer root-token', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { name: 'dev' } }),
    }),
  );

  expect(response.status).toBe(409);
  expect(response.headers.get('retry-after')).toBeNull();
});

test('it answers /health without a token, not ready before the default image is seeded', async () => {
  const ctx = await setupTest();
  const response = await ctx.impd.api.app.handle(new Request('http://impd.test/health'));
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ status: 'ok', ready: false });
});

test('it answers /health as ready once impd marks itself ready', async () => {
  const ctx = await setupTest();

  // as main.ts marks it once the default image is seeded
  ctx.impd.state.ready = true;

  const response = await ctx.impd.api.app.handle(new Request('http://impd.test/health'));
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ status: 'ok', ready: true });
});

test('it creates a running imp on the first slot with its own tap', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const created = await ctx.client.imps.create({ name: 'dev' });

  expect(created).toMatchObject({
    name: 'dev',
    image: 'ubuntu',
    state: 'running',
    slot: 0,
    ip: '10.66.0.2',
    port: 20_000,
    url: 'http://dev.imp.localhost:7080',
    ramMib: 300,
    rssMib: 340,
  });

  expect(ctx.taps).toStrictEqual(['imp0']);
});

test('it stops an imp gracefully', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  const stopped = await ctx.client.imps.stop({ name: 'dev' });

  expect(stopped.state).toBe('stopped');
  expect(ctx.vmm.stops).toStrictEqual([{ pid: 1001, graceful: true }]);
});

test('it starts a stopped imp and counts it as awake', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  const started = await ctx.client.imps.start({ name: 'dev' });
  const info = await ctx.client.system.info();

  expect(started.state).toBe('running');

  expect(info).toMatchObject({
    impCount: 1,
    awakeCount: 1,
    ramUsedMib: 300,
    ramCommittedMib: 2048,
  });
});

test('it destroys an imp and its VM', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.destroy({ name: 'dev' });

  const imps = await ctx.client.imps.list();

  expect(imps).toStrictEqual([]);
  expect(ctx.vmm.alive.size).toBe(0);
});

test('it reports only the local URL when impd has no domain', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'box' });

  const urls = await ctx.client.imps.url({ name: 'box' });

  expect(urls).toStrictEqual({
    local: 'http://box.imp.localhost:7080',
    https: null,
    public: null,
    service: null,
    tailnet: null,
  });
});

test('it reports the https URL when impd has a domain', async () => {
  const ctx = await setupTest({
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
    },
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'box' });

  const urls = await ctx.client.imps.url({ name: 'box' });

  expect(urls.https).toBe('https://box.imp.example.com');
});

test('it names a missing DNS token file as an error in system.info, and still answers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imp-dns-token-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const ctx = await setupTest({
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN_FILE: join(dir, 'dns-api-token'),
    },
  });

  const info = await ctx.client.system.info();

  expect(info.https).toStrictEqual({
    domain: 'imp.example.com',
    dnsToken: {
      isOk: false,
      error: `cannot read the DNS API token from ${join(dir, 'dns-api-token')}: ENOENT`,
      at: new Date(ctx.clock.nowMs),
    },
  });
});

test('it reads a DNS token file put in place after start, and never shows the token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imp-dns-token-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const ctx = await setupTest({
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN_FILE: join(dir, 'dns-api-token'),
    },
  });

  await writeFile(join(dir, 'dns-api-token'), 'cf-secret-token\n');

  const info = await ctx.client.system.info();

  expect(info.https?.dnsToken?.isOk).toBe(true);
  expect(JSON.stringify(info)).not.toContain('cf-secret-token');
});

test('it exposes an imp with a basic credential shown once', async () => {
  const ctx = await setupTest({
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    },
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'web' });

  const exposed = await ctx.client.imps.expose({ name: 'web', auth: 'basic' });

  expect(exposed).toStrictEqual({
    url: 'https://web.imp.example.com',
    auth: 'basic',
    user: 'imp',
    credential: exposed.credential,
  });

  expect(exposed.credential).toMatch(/^[\w-]{43}$/);
});

test('it shows an exposed imp as public', async () => {
  const ctx = await setupTest({
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    },
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'web' });
  await ctx.client.imps.expose({ name: 'web', auth: 'basic' });

  const imp = await ctx.client.imps.get({ name: 'web' });

  expect(imp.public).toStrictEqual({ auth: 'basic' });
});

test('it gives an exposed imp its public URL', async () => {
  const ctx = await setupTest({
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    },
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'web' });
  await ctx.client.imps.expose({ name: 'web', auth: 'basic' });

  const urls = await ctx.client.imps.url({ name: 'web' });

  expect(urls.public).toBe('https://web.imp.example.com');
});

test('it counts exposed imps in system.info, with no token check for a token from the env', async () => {
  const ctx = await setupTest({
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    },
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'web' });
  await ctx.client.imps.expose({ name: 'web', auth: 'basic' });

  const info = await ctx.client.system.info();

  expect(info.public).toStrictEqual({ ip: '203.0.113.7', imps: 1, records: null });
  expect(info.https).toStrictEqual({ domain: 'imp.example.com', dnsToken: null });
});

test('it keeps only a hash of an exposed imp’s credential', async () => {
  const ctx = await setupTest({
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    },
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'web' });

  const exposed = await ctx.client.imps.expose({ name: 'web', auth: 'basic' });

  const row = await ctx.db
    .selectFrom('imps')
    .select(['public_hash', 'public_user'])
    .executeTakeFirstOrThrow();

  expect(row.public_user).toBe('imp');
  expect(row.public_hash).toBeString();
  expect(row.public_hash).not.toContain(exposed.credential ?? 'no credential');
});

test('it gives a new credential to a second expose', async () => {
  const ctx = await setupTest({
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    },
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'web' });

  const first = await ctx.client.imps.expose({ name: 'web', auth: 'basic' });
  const again = await ctx.client.imps.expose({ name: 'web', auth: 'token' });

  expect(again).toStrictEqual({
    url: 'https://web.imp.example.com',
    auth: 'token',
    user: null,
    credential: again.credential,
  });

  expect(again.credential).toMatch(/^[\w-]{43}$/);
  expect(again.credential).not.toBe(first.credential);
});

test('it ends an exposure on unexpose', async () => {
  const ctx = await setupTest({
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    },
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'web' });
  await ctx.client.imps.expose({ name: 'web', auth: 'basic' });

  const unexposed = await ctx.client.imps.unexpose({ name: 'web' });
  const urls = await ctx.client.imps.url({ name: 'web' });

  expect(unexposed.public).toBeUndefined();
  expect(urls.public).toBeNull();
});

test('it refuses an expose when impd has no public mode', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'web' });

  expect(ctx.client.imps.expose({ name: 'web', auth: 'none' })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
});

test('it reports neither public mode nor HTTPS in system.info without a domain', async () => {
  const ctx = await setupTest();
  const info = await ctx.client.system.info();

  expect(info.public).toBeNull();
  expect(info.https).toBeNull();
});

test('it refuses to expose an imp that does not exist', async () => {
  const ctx = await setupTest({
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    },
  });

  expect(ctx.client.imps.expose({ name: 'nope', auth: 'none' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'nope' },
  });
});

test('it refuses a user name on an expose without basic auth', async () => {
  const ctx = await setupTest({
    env: {
      IMP_DOMAIN: 'imp.example.com',
      IMP_DNS_PROVIDER: 'cloudflare',
      IMP_DNS_API_TOKEN: 'unused',
      IMP_PUBLIC_IP: '203.0.113.7',
    },
  });

  expect(
    ctx.client.imps.expose({ name: 'nope', auth: 'token', user: 'ann' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it boots ubuntu when the configured default image is missing', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const created = await ctx.client.imps.create({ name: 'a' });

  expect(created.image).toBe('ubuntu');
});

test('it boots the configured default image, and names an imp made without a name', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const created = await ctx.client.imps.create({});

  expect(created.image).toBe('base');
  expect(created.name).toMatch(/^imp-[a-z0-9]{4}$/);
});

test('it rejects a duplicate name', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  expect(ctx.client.imps.create({ name: 'dev' })).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'imp', name: 'dev' },
  });
});

test('it rejects an unknown image', async () => {
  const ctx = await setupTest();

  expect(ctx.client.imps.create({ name: 'other', image: 'nope' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'image', name: 'nope' },
  });
});

test('it marks a running imp stopped when its VM died', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  ctx.vmm.alive.clear();

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.state).toBe('stopped');
});

test('it refuses to remove an image an imp uses', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  expect(ctx.client.images.delete({ name: 'ubuntu' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test('it makes a template image from an imp', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  const template = await ctx.client.images.add({ imp: 'dev', name: 'tools' });

  expect(template).toMatchObject({ name: 'tools', ref: 'imp:dev', source: 'imp' });
});

test('it creates an imp from a template image', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.images.add({ imp: 'dev', name: 'tools' });

  const copy = await ctx.client.imps.create({ name: 'copy', image: 'tools' });

  expect(copy.image).toBe('tools');
});

test('it lists a template image beside the image it came from', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.images.add({ imp: 'dev', name: 'tools' });

  const images = await ctx.client.images.list();

  expect(images.map((image) => [image.name, image.source])).toStrictEqual([
    ['tools', 'imp'],
    ['ubuntu', 'oci'],
  ]);
});

test('it sleeps an imp and ends its VM', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  const asleep = await ctx.client.imps.sleep({ name: 'dev' });

  expect(asleep.state).toBe('sleeping');
  expect(asleep.sleptAt).toBeValidDate();
  expect(ctx.vmm.alive.size).toBe(0);
});

test('it reports what the sleepers take back on a wake, and the default image, in system.info', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const info = await ctx.client.system.info();

  expect(info).toMatchObject({
    ramSleepingMib: 2048,
    ramCommittedMib: 0,
    defaults: { memoryMib: 2048, image: 'ubuntu' },
  });
});

test('it wakes a sleeping imp from its snapshot', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const awake = await ctx.client.imps.wake({ name: 'dev' });

  expect(awake).toMatchObject({ state: 'running', ramMib: 300 });
  expect(ctx.vmm.wakes).toStrictEqual([1002]);
});

test('it wakes a sleeping imp it holds, until the hold ends', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const held = await ctx.client.imps.hold({ name: 'dev', seconds: 60 });

  expect(held.state).toBe('running');
  expect(held.holdUntil?.getTime()).toBe(ctx.clock.nowMs + 60_000);
});

test('it releases a hold with seconds 0', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.hold({ name: 'dev', seconds: 60 });

  const released = await ctx.client.imps.hold({ name: 'dev', seconds: 0 });

  expect(released.holdUntil).toBeUndefined();
});

test('it boots cold when the snapshot belongs to another firecracker', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  const metaPath = join(ctx.dataDir, 'imps', created.id, 'snapshot', 'meta.json');

  const meta = await Bun.file(metaPath).text();

  await Bun.write(metaPath, meta.replace('"v1.17.0"', '"v0.1.0"'));

  const awake = await ctx.client.imps.wake({ name: 'dev' });

  expect(awake.state).toBe('running');
  expect(ctx.vmm.wakes).toStrictEqual([]);
});

test('it sleeps the least recently active imp to fit a new one in the budget', async () => {
  // 300 MiB per awake imp, 50% of 512 MiB reserved per boot
  const ctx = await setupTest({
    env: { IMP_RAM_BUDGET_MIB: '800', IMP_DEFAULT_MEMORY_MIB: '512' },
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'a' });

  ctx.clock.nowMs += 1000;

  await ctx.client.imps.create({ name: 'b' });

  ctx.clock.nowMs += 1000;

  await ctx.client.imps.create({ name: 'c' });

  const imps = await ctx.client.imps.list();

  expect(imps.map((imp) => [imp.name, imp.state])).toStrictEqual([
    ['a', 'sleeping'],
    ['b', 'running'],
    ['c', 'running'],
  ]);
});

test('it refuses a wake that needs more RAM than the held imps leave', async () => {
  const ctx = await setupTest({
    env: { IMP_RAM_BUDGET_MIB: '800', IMP_DEFAULT_MEMORY_MIB: '512' },
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'a' });
  await ctx.client.imps.sleep({ name: 'a' });
  await ctx.client.imps.create({ name: 'b' });
  await ctx.client.imps.create({ name: 'c' });
  await ctx.client.imps.hold({ name: 'b', seconds: 600 });
  await ctx.client.imps.hold({ name: 'c', seconds: 600 });

  expect(ctx.client.imps.wake({ name: 'a' })).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: { budgetMib: 800, requestedMib: 300 },
  });
});

test('it keeps the sleeping imp and its snapshot when the budget turns away a cold boot', async () => {
  const ctx = await setupTest({
    env: { IMP_RAM_BUDGET_MIB: '800', IMP_DEFAULT_MEMORY_MIB: '512' },
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const asleep = await ctx.client.imps.create({ name: 'a' });

  await ctx.client.imps.sleep({ name: 'a' });
  await ctx.client.imps.create({ name: 'b' });
  await ctx.client.imps.create({ name: 'c' });
  await ctx.client.imps.hold({ name: 'b', seconds: 600 });
  await ctx.client.imps.hold({ name: 'c', seconds: 600 });

  // a snapshot from another firecracker: the wake falls back to a cold boot
  const metaPath = join(ctx.dataDir, 'imps', asleep.id, 'snapshot', 'meta.json');

  const meta = await Bun.file(metaPath).text();

  await Bun.write(metaPath, meta.replace('"v1.17.0"', '"v0.1.0"'));

  expect(ctx.client.imps.wake({ name: 'a' })).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
  });

  // the raw row: a read through the service would repair a lost snapshot
  const row = await findImpByName(ctx.db, 'a');

  expect(row?.state).toBe('sleeping');
  expect(existsSync(metaPath)).toBeTrue();
});

test('it leaves nothing behind when an imp is larger than the RAM budget', async () => {
  const ctx = await setupTest({ env: { IMP_RAM_BUDGET_MIB: '800' } });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  expect(ctx.client.imps.create({ name: 'huge', memoryMib: 900 })).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: { requestedMib: 900 },
  });

  const imps = await ctx.client.imps.list();
  const dirs = await readdir(join(ctx.dataDir, 'imps'));

  expect(imps).toStrictEqual([]);
  expect(dirs).toStrictEqual([]);
});

test('it frees the name and the slot of a create the RAM budget refused', async () => {
  const ctx = await setupTest({ env: { IMP_RAM_BUDGET_MIB: '800' } });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  // refused: the budget is 800 MiB
  await Promise.allSettled([ctx.client.imps.create({ name: 'huge', memoryMib: 900 })]);

  const created = await ctx.client.imps.create({ name: 'huge', memoryMib: 512 });

  expect(created).toMatchObject({ state: 'running', slot: 0 });
});

test('it records a boot failure as the error state with its first line', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  ctx.vmm.queue('boot', 'fail');

  expect(ctx.client.imps.create({ name: 'dev' })).rejects.toThrow();

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp).toMatchObject({
    state: 'error',
    error: 'boot failed: no agent',
  });
});

test('it starts an imp in error', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  ctx.vmm.queue('boot', 'fail');

  // the boot fails, as queued
  await Promise.allSettled([ctx.client.imps.create({ name: 'dev' })]);

  const started = await ctx.client.imps.start({ name: 'dev' });

  expect(started.state).toBe('running');
});

test('it re-adopts live VMs on reconcile, even with a silent agent', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'alive' });
  await ctx.client.imps.create({ name: 'dead' });
  await ctx.client.imps.create({ name: 'asleep' });
  await ctx.client.imps.sleep({ name: 'asleep' });

  const dead = await ctx.client.imps.get({ name: 'dead' });

  ctx.vmm.alive.delete(1002);
  ctx.vmm.queue('agentReady', 'fail');

  await ctx.impd.imps.reconcileImps();

  const imps = await ctx.client.imps.list();

  expect(dead.state).toBe('running');

  expect(imps.map((imp) => [imp.name, imp.state])).toStrictEqual([
    ['alive', 'running'],
    ['asleep', 'sleeping'],
    ['dead', 'stopped'],
  ]);

  expect(ctx.vmm.stops).toStrictEqual([]);
});

test('it keeps an imp running for a read during a lifecycle operation', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  const gate = ctx.vmm.hold('sleep');
  const sleeping = ctx.client.imps.sleep({ name: 'dev' });

  await gate.reached;

  // the VM looks dead to a reader while the sleep holds the lock
  ctx.vmm.alive.clear();

  const during = await ctx.client.imps.get({ name: 'dev' });

  gate.release();

  const after = await sleeping;

  expect(during.state).toBe('running');
  expect(after.state).toBe('sleeping');
});

test('it closes exec sessions with 1012 when impd stops', async () => {
  const ctx = await setupTest();

  const socket = new WebSocket(`ws://127.0.0.1:${ctx.port}/exec`, {
    headers: { authorization: 'Bearer root-token' },
  });

  onTestFinished(() => {
    socket.close();
  });

  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<CloseEvent>();

  socket.addEventListener('open', () => {
    opened.resolve();
  });

  socket.addEventListener('close', closed.resolve);

  await opened.promise;

  ctx.impd.api.closeExecSessions();

  const event = await closed.promise;

  expect(event.code).toBe(1012);
});

test('it refuses the socket of an exec ticket for another imp', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'other' });

  const issued = await ctx.client.exec.ticket({ name: 'other' });

  // accepted at the upgrade, refused at start: the session starts imp dev
  const reply = await tryExecSocket(ctx.port, `ticket=${issued.ticket}`);

  expect(JSON.parse(reply)).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
});

test('it refuses an exec ticket used once', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'other' });

  const issued = await ctx.client.exec.ticket({ name: 'other' });

  await tryExecSocket(ctx.port, `ticket=${issued.ticket}`);

  const reused = await tryExecSocket(ctx.port, `ticket=${issued.ticket}`);

  expect(reused).toBe('rejected');
});

test("it keeps the reference an image add's pull resolved in its audit row", async () => {
  const ctx = await setupTest({ env: { IMP_BUILD_ISOLATION: 'host' } });

  const pulled = `busybox@sha256:${'d'.repeat(64)}`;

  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  // the image is not on the host: the add pulls it, then unpacks its export
  const docker = buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: ['busybox'],
        inspects: [{ Id: `sha256:${'b'.repeat(64)}`, Config: {}, Size: 2, RepoDigests: [pulled] }],
        isOnHost: false,
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout,
  });

  updateEnv('PATH', docker.path);

  await ctx.client.images.add({ ref: 'busybox', name: 'box' });

  // the row lands after the answer
  const details = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, null, 10, null);

    const adds = rows.filter((row) => row.procedure === 'images.add');

    expect(adds).not.toBeEmpty();

    return adds.map((row) => row.detail);
  });

  expect(details).toStrictEqual([pulled]);
});

test('it audits an exec on a ticket the token asked for as the token', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  const issued = await ctx.client.exec.ticket({ name: 'dev' });

  await tryExecSocket(ctx.port, `ticket=${issued.ticket}`);

  // the row lands after the open settles
  const actors = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, 'dev', 10, null);

    const execs = rows.filter((row) => row.procedure === 'exec');

    expect(execs).not.toBeEmpty();

    return execs.map((row) => row.actor);
  });

  expect(actors).toStrictEqual(['token']);
});

test('it lets a bearer exec socket start any imp', async () => {
  const ctx = await setupTest();

  const reply = await tryExecSocket(ctx.port, '', 'other', {
    authorization: 'Bearer root-token',
  });

  // past the grant: the imp does not exist
  expect(JSON.parse(reply)).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
});

test('it refuses an expired exec ticket', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  const issued = await ctx.client.exec.ticket({ name: 'dev' });

  ctx.clock.nowMs += 30_000;

  const expired = await tryExecSocket(ctx.port, `ticket=${issued.ticket}`);

  expect(expired).toBe('rejected');
});

test('it refuses the token in the query of /exec', async () => {
  const ctx = await setupTest();
  const reply = await tryExecSocket(ctx.port, 'token=root-token');

  expect(reply).toBe('rejected');
});

test('it refuses a ticket on /tunnel', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  const issued = await ctx.client.exec.ticket({ name: 'dev' });
  const reply = await tryTunnelSocket(ctx.port, `ticket=${issued.ticket}`, {});

  expect(reply).toBe('rejected');
});

test('it takes the bearer header on /tunnel', async () => {
  const ctx = await setupTest();
  const reply = await tryTunnelSocket(ctx.port, '', { authorization: 'Bearer root-token' });

  // past the auth: the imp does not exist
  expect(JSON.parse(reply)).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
});

test('it refuses a tunnel into an imp to a token without exec', async () => {
  const ctx = await setupTest();
  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const reply = await tryTunnelSocket(
    ctx.port,
    '',
    { authorization: `Bearer ${made.secret}` },
    'dev',
  );

  expect(JSON.parse(reply)).toMatchObject({
    type: 'error',
    code: 'FORBIDDEN',
    message: 'token reader may not open a tunnel into imp dev',
  });
});

test('it audits a tunnel open as the token, with the imp and the port', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  await tryTunnelSocket(ctx.port, '', { authorization: 'Bearer root-token' }, 'dev');

  // the row lands after the open settles
  const tunnels = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, 'dev', 10, null);

    const opens = rows.filter((row) => row.procedure.startsWith('tunnel'));

    expect(opens).not.toBeEmpty();

    return opens.map((row) => [row.procedure, row.actor]);
  });

  expect(tunnels).toStrictEqual([['tunnel:5432', 'token']]);
});

test('it closes tunnels with 1012 when impd stops', async () => {
  const ctx = await setupTest();

  const socket = new WebSocket(`ws://127.0.0.1:${ctx.port}/tunnel`, {
    headers: { authorization: 'Bearer root-token' },
  });

  onTestFinished(() => {
    socket.close();
  });

  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<CloseEvent>();

  socket.addEventListener('open', () => {
    opened.resolve();
  });

  socket.addEventListener('close', closed.resolve);

  await opened.promise;

  ctx.impd.api.closeExecSessions();

  const event = await closed.promise;

  expect(event.code).toBe(1012);
});

test('it refuses an exec ticket for an imp that does not exist', async () => {
  const ctx = await setupTest();

  expect(ctx.client.exec.ticket({ name: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('it refuses a wake of an imp in error when restartError is false', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  ctx.vmm.queue('boot', 'fail');

  // the boot fails, as queued
  await Promise.allSettled([ctx.client.imps.create({ name: 'dev' })]);

  expect(ctx.client.imps.wake({ name: 'dev', restartError: false })).rejects.toMatchObject({
    code: 'INVALID_STATE',
    data: { state: 'error', allowed: ['running', 'sleeping', 'stopped'] },
  });
});

test('it restarts an imp in error on a wake', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  ctx.vmm.queue('boot', 'fail');

  // the boot fails, as queued
  await Promise.allSettled([ctx.client.imps.create({ name: 'dev' })]);

  const restarted = await ctx.client.imps.wake({ name: 'dev' });

  expect(restarted.state).toBe('running');
});
