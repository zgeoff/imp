import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { server } from '@imp/test-utils/mock-server';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { HttpResponse, http } from 'msw';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createImage } from '../db/images';
import { findImpByName, updateImpMove } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { setupImpTest } from '../imps/test-imps';
import { deriveSlotAddress } from '../net/addressing';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubTailscaleApi } from '../test-utils/build-stub-tailscale-api';
import { buildStubTailscaleServe } from '../test-utils/build-stub-tailscale-serve';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { createPresenceCheck } from './build-tailnet-names';
import { createServiceServe } from './service-serve';
import { createServicesApi } from './services-api';
import { SERVICE_TAG, createTailnetNames } from './tailnet-names';
import type { TailnetNamesDeps } from './tailnet-names';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'tailnet-names-'));

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

    // the bearer the test's client sends
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

    // no IPv6 and no tailnet node: these names come from the deps below
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
  });

  stack.defer(() => {
    impd.diskUsage.stop();
  });

  // the image every imp here boots
  await Bun.write(join(dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(db, { name: 'base', ref: 'base:latest', digest: 'sha256:base', sizeBytes: 6 });

  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  // the OAuth client the stub tailnet knows, which every API call needs a token from
  const tailscaleApi = buildStubTailscaleApi({
    client: { clientId: 'kExample', clientSecret: 'secret' },
  });

  server.use(...tailscaleApi.handlers);

  const tailscale = buildStubTailscaleServe();
  const logs: string[] = [];

  // every dep but the host's ID, through the real Services API client and
  // `tailscale serve` against their stand-ins
  const namesDeps: Omit<TailnetNamesDeps, 'hostId'> = {
    config: { prefix: '', oauthFile: join(dataDir, 'unused-oauth.json') },
    db,
    api: createServicesApi({
      readCredential: () => ({ clientId: 'kExample', clientSecret: 'secret' }),
    }),
    serve: createServiceServe(tailscale.runChecked),
    findPort: (slot) => deriveSlotAddress(slot, config).tailnetPort,
    isImpPresent: createPresenceCheck(impd.imps, db),
    readSuffix: () => Promise.resolve('tail1234.ts.net'),
    log: (line) => {
      logs.push(line);
    },
  };

  return { config, db, client, tailscaleApi, tailscale, logs, namesDeps };
}

test('it claims a service of this host’s for each imp', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  const stored: unknown[] = ctx.tailscaleApi.services.all();

  expect(stored).toStrictEqual([
    {
      name: 'svc:box',
      comment: 'imp host host-a',
      ports: ['tcp:80', 'tcp:443'],
      tags: [SERVICE_TAG],
    },
  ]);
});

test('it reads the service again before it writes it', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(
    ctx.tailscaleApi.requests.map((request) => `${request.method} ${request.path}`),
  ).toStrictEqual([
    'POST /oauth/token',
    'GET /tailnet/-/services',
    'GET /tailnet/-/services/svc%3Abox',
    'PUT /tailnet/-/services/svc%3Abox',
  ]);
});

test('it serves each imp’s service to the imp’s own port', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const imp = await findImpByName(ctx.db, 'box');

  invariant(imp);

  const target = `http://127.0.0.1:${String(deriveSlotAddress(imp.slot, ctx.config).tailnetPort)}`;
  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(ctx.tailscale.calls).toStrictEqual([
    ['tailscale', 'serve', 'status', '--json'],
    ['tailscale', 'serve', '--service=svc:box', '--http=80', target],
    ['tailscale', 'serve', '--service=svc:box', '--https=443', target],
  ]);
});

test('it gives a live name its https URL on the tailnet', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(names.readUrl('box')).toBe('https://box.tail1234.ts.net');
});

test('it gives no URL while the tailnet suffix is unknown', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({
    ...ctx.namesDeps,
    hostId: 'host-a',
    readSuffix: () => Promise.resolve(null),
  });

  await names.runSync();

  expect(names.readUrl('box')).toBeNull();
});

test('it counts each live name in its status', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(names.readStatus()).toStrictEqual({ live: 1, failed: [] });
});

test('it logs a name once when it goes live', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();
  await names.runSync();

  expect(ctx.logs).toStrictEqual(['impd: tailnet names: box is svc:box']);
});

test('it only lists the services on a pass that finds everything in place', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  const before = ctx.tailscaleApi.requests.length;
  const servedBefore = ctx.tailscale.calls.length;

  await names.runSync();

  expect(
    ctx.tailscaleApi.requests.slice(before).map((request) => `${request.method} ${request.path}`),
  ).toStrictEqual(['GET /tailnet/-/services']);

  expect(ctx.tailscale.calls.slice(servedBefore)).toStrictEqual([
    ['tailscale', 'serve', 'status', '--json'],
  ]);
});

test('it never writes over a service by that name that another owner holds', async () => {
  const ctx = await setupTest();

  await ctx.tailscaleApi.services.create({ name: 'svc:box', comment: 'the web team', tags: [] });
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(ctx.tailscaleApi.requests.map((request) => request.method)).not.toContain('PUT');

  expect(
    ctx.tailscaleApi.services.findFirst((query) => query.where({ name: 'svc:box' })),
  ).toMatchObject({
    comment: 'the web team',
  });
});

test('it fails a name another owner holds, and gives it no URL', async () => {
  const ctx = await setupTest();

  await ctx.tailscaleApi.services.create({ name: 'svc:box', comment: 'the web team', tags: [] });

  await ctx.tailscaleApi.services.create({
    name: 'svc:web',
    comment: 'imp host host-b',
    tags: [SERVICE_TAG],
  });

  await ctx.client.imps.create({ name: 'box' });
  await ctx.client.imps.create({ name: 'web' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(names.readUrl('box')).toBeNull();

  expect(names.readStatus()).toStrictEqual({
    live: 0,
    failed: [
      { name: 'box', error: 'svc:box exists and this host does not own it' },
      { name: 'web', error: 'svc:web exists and this host does not own it' },
    ],
  });
});

test('it fails a name whose service appears after the list, and never writes it', async () => {
  const ctx = await setupTest();

  await ctx.tailscaleApi.services.create({ name: 'svc:box', comment: 'someone else', tags: [] });
  await ctx.client.imps.create({ name: 'box' });

  // the list was read before the other owner made the service
  server.use(
    http.get(
      'https://api.tailscale.com/api/v2/tailnet/-/services',
      () => HttpResponse.json({ vipServices: [] }),
      { once: true },
    ),
  );

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(names.readStatus().failed).toStrictEqual([
    { name: 'box', error: 'svc:box exists and this host does not own it' },
  ]);

  expect(ctx.tailscaleApi.requests.map((request) => request.method)).not.toContain('PUT');
});

test('it clears a destroyed imp’s serve config, then deletes its service', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();
  await ctx.client.imps.destroy({ name: 'box' });

  // the last serve call made when the delete arrives
  const lastServeAtDelete = mock<(argv: readonly string[] | undefined) => void>();

  server.use(
    http.delete('https://api.tailscale.com/api/v2/tailnet/-/services/:name', () => {
      lastServeAtDelete(ctx.tailscale.calls.at(-1));
    }),
  );

  await names.runSync();

  expect(lastServeAtDelete).toHaveBeenCalledExactlyOnceWith([
    'tailscale',
    'serve',
    'clear',
    'svc:box',
  ]);

  expect(ctx.tailscaleApi.services.count()).toBe(0);
});

test('it logs the removal of a service no imp has', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();
  await ctx.client.imps.destroy({ name: 'box' });
  await names.runSync();

  expect(ctx.logs.at(-1)).toBe('impd: tailnet names: removed svc:box, which no imp has');
});

test('it never removes another host’s, another owner’s or an untagged service', async () => {
  const ctx = await setupTest();

  await ctx.tailscaleApi.services.create({
    name: 'svc:other',
    comment: 'imp host host-b',
    tags: [SERVICE_TAG],
  });

  await ctx.tailscaleApi.services.create({ name: 'svc:team', comment: 'the web team', tags: [] });

  await ctx.tailscaleApi.services.create({
    name: 'svc:untagged',
    comment: 'imp host host-a',
    tags: [],
  });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(ctx.tailscaleApi.services.all().map((service) => service.name)).toIncludeSameMembers([
    'svc:other',
    'svc:team',
    'svc:untagged',
  ]);
});

test('it keeps a moving imp’s service while the move sends', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const imp = await findImpByName(ctx.db, 'box');

  invariant(imp);

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  await updateImpMove(ctx.db, imp.id, 'sending');

  await names.runSync();

  expect(ctx.tailscaleApi.services.count()).toBe(1);
});

test('it removes a moved imp’s service once the target holds a verified copy', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const imp = await findImpByName(ctx.db, 'box');

  invariant(imp);

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  await updateImpMove(ctx.db, imp.id, 'moved');

  await names.runSync();

  expect(ctx.tailscaleApi.services.count()).toBe(0);
});

test('it never removes a service another host claimed for an imp it no longer has', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const first = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await first.runSync();
  await ctx.client.imps.destroy({ name: 'box' });

  const second = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-b' });

  await second.runSync();

  expect(ctx.tailscaleApi.services.all().map((service) => service.name)).toStrictEqual(['svc:box']);
});

test('it fails every name with the error while the API is down', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  server.use(
    http.get('https://api.tailscale.com/api/v2/tailnet/-/services', () =>
      HttpResponse.json({ message: 'unavailable' }, { status: 503 }),
    ),
  );

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(names.readStatus()).toStrictEqual({
    live: 0,
    failed: [{ name: 'box', error: 'Tailscale GET /tailnet/-/services: 503 unavailable' }],
  });
});

test('it logs a failure once while it stays the same', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  server.use(
    http.get('https://api.tailscale.com/api/v2/tailnet/-/services', () =>
      HttpResponse.json({ message: 'unavailable' }, { status: 503 }),
    ),
  );

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();
  await names.runSync();

  expect(ctx.logs).toStrictEqual([
    'impd: tailnet names: box: Tailscale GET /tailnet/-/services: 503 unavailable',
  ]);
});

test('it brings a name back on the pass after an outage ends', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  server.use(
    http.get(
      'https://api.tailscale.com/api/v2/tailnet/-/services',
      () => HttpResponse.json({ message: 'unavailable' }, { status: 503 }),
      { once: true },
    ),
  );

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  const duringOutage = names.readStatus();

  await names.runSync();

  expect(duringOutage.live).toBe(0);
  expect(names.readStatus()).toStrictEqual({ live: 1, failed: [] });
});

test('it fails only the imp whose name a device holds, and keeps that imp running', async () => {
  const ctx = await setupTest();

  server.use(
    http.put('https://api.tailscale.com/api/v2/tailnet/-/services/svc%3Alaptop', () =>
      HttpResponse.json({ message: 'name in use by a machine' }, { status: 400 }),
    ),
  );

  await ctx.client.imps.create({ name: 'laptop' });
  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  const laptop = await findImpByName(ctx.db, 'laptop');

  expect(names.readStatus()).toStrictEqual({
    live: 1,
    failed: [
      {
        name: 'laptop',
        error: 'Tailscale PUT /tailnet/-/services/svc%3Alaptop: 400 name in use by a machine',
      },
    ],
  });

  expect(laptop?.state).toBe('running');
});

test('it clears serve config for a service gone from the tailnet', async () => {
  const ctx = await setupTest();

  await ctx.tailscale.runChecked([
    'tailscale',
    'serve',
    '--service=svc:gone',
    '--http=80',
    'http://127.0.0.1:20005',
  ]);

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();

  expect(ctx.tailscale.calls.at(-1)).toStrictEqual(['tailscale', 'serve', 'clear', 'svc:gone']);
});

test('it logs a removal that fails, and goes on with the pass', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const names = createTailnetNames({ ...ctx.namesDeps, hostId: 'host-a' });

  await names.runSync();
  await ctx.client.imps.destroy({ name: 'box' });

  server.use(
    http.delete('https://api.tailscale.com/api/v2/tailnet/-/services/:name', () =>
      HttpResponse.json({ message: 'forbidden' }, { status: 403 }),
    ),
  );

  await names.runSync();

  expect(ctx.logs.at(-1)).toBe(
    'impd: tailnet names: removing svc:box: Tailscale DELETE /tailnet/-/services/svc%3Abox: 403 forbidden',
  );
});

test('it shows an imp’s service URL once its name is live', async () => {
  const live = new Set<string>();

  // impd's own wiring reaches tailnet names only through `tailscale serve`
  // on the host, so this shim stands in for the names' readUrl
  const ctx = await setupImpTest({
    readServiceUrl: (name) => (live.has(name) ? `https://${name}.tail1234.ts.net` : null),
  });

  await ctx.createTestImage('base');
  await ctx.imps.createImp({ name: 'box' });

  live.add('box');

  const urls = await ctx.imps.readUrls('box');

  expect(urls.service).toBe('https://box.tail1234.ts.net');
});

test('it shows no service URL before the name is live', async () => {
  const ctx = await setupImpTest({ readServiceUrl: () => null });

  await ctx.createTestImage('base');
  await ctx.imps.createImp({ name: 'box' });

  const urls = await ctx.imps.readUrls('box');

  expect(urls.service).toBeNull();
});
