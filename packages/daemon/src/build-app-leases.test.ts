import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpEvent } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImpClient } from '@zgeoff/imp-client';
import { loadConfig } from './config';
import { createImpd } from './create-impd';
import { createImage } from './db/images';
import { listLeases, writeLease } from './db/leases';
import { openDatabase } from './db/open-database';
import { readPresentedLeases } from './imps/imp-presenter';
import { buildSystemDrivePath, buildSystemDrivesDir } from './storage/data-layout';
import { createXfsBackend } from './storage/xfs-backend';
import { buildStubCpuCgroups } from './test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from './test-utils/build-stub-vmm';
import { findFreePorts } from './test-utils/find-free-ports';

interface SetupOptions {
  // impd's environment past what every test boots with
  readonly env?: Readonly<Record<string, string>>;
}

// impd's real app on stub VMs, on a clock the test steps, with every event
// it emits and a root client that reaches the app in process
async function setupTest(options: SetupOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'build-app-leases-'));

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
    ...options.env,
  });

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  // the clock leases and holds run on; it moves only when a test moves it
  const clock = { nowMs: Date.now() };
  const vmm = buildStubVmm();

  // each unexpected failure behind an RPC, which impd logs to stderr
  const rpcFailures: unknown[] = [];

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
    logRpcFailure: (failure) => {
      rpcFailures.push(failure);
    },
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
      // 300 MiB per awake imp, as the governor measures it
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

  const events: ImpEvent[] = [];

  const unsubscribe = impd.imps.events.subscribe((event) => {
    events.push(event);
  });

  stack.defer(unsubscribe);

  // the image every imps.create boots when it names none
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const sendToImpd = (request: Request) => impd.api.app.handle(request);

  return {
    db,
    impd,
    vmm,
    clock,
    events,
    rpcFailures,
    sendToImpd,
    client: createImpClient({ url: 'http://impd.test', token: 'root-token', fetch: sendToImpd }),
  };
}

test('it answers an acquire with the lease’s owner and end', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const a = createImpClient({ url: 'http://impd.test', token: made.secret, fetch: ctx.sendToImpd });

  const leased = await a.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  const principal = ctx.impd.tokens.authenticate(made.secret)?.principal;

  invariant(principal);

  expect(leased).toStrictEqual({
    name: 'dev',
    owner: {
      principal,
      display: 'a',
      label: 'job',
    },
    until: new Date(ctx.clock.nowMs + 60_000),
  });
});

test('it lists a token only its own leases', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const a = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const b = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await a.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await b.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 120 });

  const seen = await a.leases.list({});

  expect(seen.map((lease) => lease.owner.display)).toStrictEqual(['a']);
});

test('it lists root every owner’s lease', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const a = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const b = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await a.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await b.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 120 });

  const seen = await ctx.client.leases.list({ name: 'dev' });

  expect(seen.map((lease) => lease.owner.display).toSorted()).toStrictEqual(['a', 'b']);
});

test('it names a token’s own leases on the imp and counts the others', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const a = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const b = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await a.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await b.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 120 });

  const imp = await a.imps.get({ name: 'dev' });

  expect(imp.leases?.leases.map((lease) => lease.owner.display)).toStrictEqual(['a']);
  expect(imp.leases?.otherCount).toBe(1);
});

test('it names every lease on the imp to root and holds it until the longest ends', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const a = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const b = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await a.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await b.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 120 });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.leases?.otherCount).toBe(0);
  expect(imp.holdUntil).toStrictEqual(new Date(ctx.clock.nowMs + 120_000));
});

test('it releases only the caller’s own lease', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const a = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const b = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await a.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await b.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 120 });

  const released = await a.leases.release({ name: 'dev', label: 'job' });
  const left = await ctx.client.leases.list({});

  expect(released).toStrictEqual({ released: true });
  expect(left.map((lease) => lease.owner.display)).toStrictEqual(['b']);
});

test('it answers a release of a lease already released with released false', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await ctx.client.leases.release({ name: 'dev', label: 'job' });

  const again = await ctx.client.leases.release({ name: 'dev', label: 'job' });

  expect(again).toStrictEqual({ released: false });
});

test('it moves the end of a live lease on a renew', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 30 });

  ctx.clock.nowMs += 20_000;

  const renewed = await ctx.client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 30 });

  expect(renewed.until).toStrictEqual(new Date(ctx.clock.nowMs + 30_000));
});

test('it never shortens a lease on a renew with a shorter ttl', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const leased = await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 30 });
  const kept = await ctx.client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 10 });

  expect(kept.until).toStrictEqual(leased.until);
});

test('it refuses a renew of an ended lease and wakes nothing', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 30 });

  ctx.clock.nowMs += 30_000;

  await ctx.client.imps.sleep({ name: 'dev' });

  expect(
    ctx.client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 30 }),
  ).rejects.toMatchObject({ code: 'LEASE_NOT_HELD' });

  const imp = await ctx.client.imps.get({ name: 'dev' });
  const leases = await ctx.client.leases.list({});

  expect(imp.state).toBe('sleeping');
  expect(imp.holdUntil).toBeUndefined();
  expect(leases).toStrictEqual([]);
});

test('it wakes a sleeping imp on an acquire', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.state).toBe('running');
});

test('it emits held with the lease counts but no owners on an acquire', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  const held = await waitFor(() => {
    const found = ctx.events.find((event) => event.ev === 'ImpChanged' && event.reason === 'held');

    expect(found).toBeDefined();

    return found;
  });

  expect(held).toMatchObject({ imp: { leases: { leases: [], otherCount: 1 } } });
});

test('it refuses a lease with the label hold', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  expect(
    ctx.client.leases.acquire({ name: 'dev', label: 'hold', ttlSeconds: 60 }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it refuses another token’s sleep of a leased imp with LEASED and hides the owner', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const a = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const b = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await a.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  expect(b.imps.sleep({ name: 'dev' })).rejects.toMatchObject({
    code: 'LEASED',
    data: { leases: [], otherCount: 1 },
  });
});

test('it refuses the owner’s stop of a leased imp with LEASED naming its lease', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const a = createImpClient({ url: 'http://impd.test', token: made.secret, fetch: ctx.sendToImpd });

  await a.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  expect(a.imps.stop({ name: 'dev' })).rejects.toMatchObject({
    code: 'LEASED',
    data: {
      leases: [
        {
          owner: { principal: ctx.impd.tokens.authenticate(made.secret)?.principal, label: 'job' },
        },
      ],
      otherCount: 0,
    },
  });
});

test('it refuses root’s sleep of a leased imp with LEASED and keeps it running', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const a = createImpClient({ url: 'http://impd.test', token: made.secret, fetch: ctx.sendToImpd });

  await a.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  expect(ctx.client.imps.sleep({ name: 'dev' })).rejects.toMatchObject({
    code: 'LEASED',
    data: { otherCount: 0 },
  });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.state).toBe('running');
});

test('it ends every lease on a forced sleep and keeps the holds', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const a = createImpClient({ url: 'http://impd.test', token: made.secret, fetch: ctx.sendToImpd });

  await a.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await a.leases.acquire({ name: 'dev', label: 'other', ttlSeconds: 60 });
  await ctx.client.imps.hold({ name: 'dev', seconds: 600 });

  const asleep = await ctx.client.imps.sleep({ name: 'dev', force: true });
  const leases = await ctx.client.leases.list({ name: 'dev' });

  expect(asleep.state).toBe('sleeping');
  expect(asleep.holdUntil).toStrictEqual(new Date(ctx.clock.nowMs + 600_000));
  expect(leases.map((lease) => lease.owner.label)).toStrictEqual(['hold']);
});

test('it emits released with the count of leases a forced sleep ended', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const a = createImpClient({ url: 'http://impd.test', token: made.secret, fetch: ctx.sendToImpd });

  await a.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await a.leases.acquire({ name: 'dev', label: 'other', ttlSeconds: 60 });
  await ctx.client.imps.hold({ name: 'dev', seconds: 600 });
  await ctx.client.imps.sleep({ name: 'dev', force: true });

  const released = await waitFor(() => {
    const found = ctx.events.find(
      (event) => event.ev === 'ImpChanged' && event.reason === 'released',
    );

    expect(found).toBeDefined();

    return found;
  });

  expect(released).toMatchObject({ detail: { released: 2 } });
});

test('it refuses a renew of a lease a forced sleep ended', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const a = createImpClient({ url: 'http://impd.test', token: made.secret, fetch: ctx.sendToImpd });

  await a.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await ctx.client.imps.sleep({ name: 'dev', force: true });

  expect(a.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 60 })).rejects.toMatchObject({
    code: 'LEASE_NOT_HELD',
  });
});

test('it sleeps a held imp on a sleep without force', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.hold({ name: 'dev', seconds: 600 });

  const asleep = await ctx.client.imps.sleep({ name: 'dev' });

  expect(asleep.state).toBe('sleeping');
});

test('it stops a held imp and keeps the hold', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.hold({ name: 'dev', seconds: 600 });

  const stopped = await ctx.client.imps.stop({ name: 'dev' });

  expect(stopped.state).toBe('stopped');
  expect(stopped.holdUntil).toStrictEqual(new Date(ctx.clock.nowMs + 600_000));
});

test('it releases the caller’s hold and a legacy one on hold 0, and keeps the others', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });
  const madeA = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });
  const madeB = await ctx.client.tokens.create({ name: 'b', scope: 'exec' });

  const a = createImpClient({
    url: 'http://impd.test',
    token: madeA.secret,
    fetch: ctx.sendToImpd,
  });

  const b = createImpClient({
    url: 'http://impd.test',
    token: madeB.secret,
    fetch: ctx.sendToImpd,
  });

  await a.imps.hold({ name: 'dev', seconds: 600 });
  await b.imps.hold({ name: 'dev', seconds: 900 });
  await b.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  // a hold from before holds had owners
  await writeLease(
    ctx.db,
    {
      impId: created.id,
      principal: 'legacy',
      label: 'hold',
      display: 'legacy',
      until: new Date(ctx.clock.nowMs + 300_000),
      createdAt: new Date(ctx.clock.nowMs),
    },
    { at: ctx.clock.nowMs, reason: null },
  );

  await a.imps.hold({ name: 'dev', seconds: 0 });

  const left = await listLeases(ctx.db, ctx.clock.nowMs);

  const principalOfB = ctx.impd.tokens.authenticate(madeB.secret)?.principal;

  expect(left.map((lease) => `${lease.principal}/${lease.label}`)).toStrictEqual([
    `${String(principalOfB)}/hold`,
    `${String(principalOfB)}/job`,
  ]);
});

test('it gives a new token with a deleted token’s name another principal', async () => {
  const ctx = await setupTest();
  const first = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  await ctx.client.tokens.delete({ name: 'ci' });

  const second = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  expect(ctx.impd.tokens.authenticate(second.secret)?.principal).not.toBe(
    ctx.impd.tokens.authenticate(first.secret)?.principal ?? null,
  );
});

test('it lists a new token with a deleted token’s name none of its leases', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const first = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  await createImpClient({
    url: 'http://impd.test',
    token: first.secret,
    fetch: ctx.sendToImpd,
  }).leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  await ctx.client.tokens.delete({ name: 'ci' });

  const second = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const seen = await createImpClient({
    url: 'http://impd.test',
    token: second.secret,
    fetch: ctx.sendToImpd,
  }).leases.list({});

  expect(seen).toStrictEqual([]);
});

test('it refuses a renew by a new token of a deleted token’s lease', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const first = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  await createImpClient({
    url: 'http://impd.test',
    token: first.secret,
    fetch: ctx.sendToImpd,
  }).leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  await ctx.client.tokens.delete({ name: 'ci' });

  const second = await ctx.client.tokens.create({ name: 'ci', scope: 'exec' });

  const client = createImpClient({
    url: 'http://impd.test',
    token: second.secret,
    fetch: ctx.sendToImpd,
  });

  expect(client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 60 })).rejects.toMatchObject({
    code: 'LEASE_NOT_HELD',
  });
});

test('it leaves out of a list the imps a limited caller may not reach', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'limited', scope: 'exec', imps: ['dev-*'] });

  const limited = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  await ctx.client.leases.acquire({ name: 'prod', label: 'job', ttlSeconds: 60 });
  await limited.leases.acquire({ name: 'dev-a', label: 'job', ttlSeconds: 60 });

  const all = await limited.leases.list({});

  expect(all.map((lease) => lease.name)).toStrictEqual(['dev-a']);
});

test('it refuses a limited caller the leases of an imp it may not reach', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'prod' });

  const made = await ctx.client.tokens.create({ name: 'limited', scope: 'exec', imps: ['dev-*'] });

  const limited = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(limited.leases.list({ name: 'prod' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it sleeps a leased imp in the shutdown pass and keeps its lease', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await ctx.impd.imps.sleepAllImps();

  const leases = await listLeases(ctx.db, ctx.clock.nowMs);

  expect(ctx.vmm.alive.size).toBe(0);
  expect(leases.map((lease) => lease.label)).toStrictEqual(['job']);
});

test('it names only the protected imps the caller may read in a RAM refusal', async () => {
  // 300 MiB per awake imp, 50% of 512 MiB reserved per boot
  const ctx = await setupTest({
    env: { IMP_RAM_BUDGET_MIB: '800', IMP_DEFAULT_MEMORY_MIB: '512' },
  });

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.sleep({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'dev-b' });
  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.leases.acquire({ name: 'dev-b', label: 'job', ttlSeconds: 600 });
  await ctx.client.leases.acquire({ name: 'prod', label: 'job', ttlSeconds: 600 });

  const made = await ctx.client.tokens.create({ name: 'limited', scope: 'exec', imps: ['dev-*'] });

  const limited = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(
    limited.leases.acquire({ name: 'dev-a', label: 'job', ttlSeconds: 60 }),
  ).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: {
      budgetMib: 800,
      neededMib: 100,
      protected: [{ name: 'dev-b', ramMib: 300, leased: true, busy: false }],
      protectedHidden: 1,
    },
  });

  const leases = await ctx.client.leases.list({ name: 'dev-a' });

  expect(leases).toStrictEqual([]);
});

test('it emits the governor’s refusal with every protected imp counted', async () => {
  // 300 MiB per awake imp, 50% of 512 MiB reserved per boot
  const ctx = await setupTest({
    env: { IMP_RAM_BUDGET_MIB: '800', IMP_DEFAULT_MEMORY_MIB: '512' },
  });

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.sleep({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'dev-b' });
  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.leases.acquire({ name: 'dev-b', label: 'job', ttlSeconds: 600 });
  await ctx.client.leases.acquire({ name: 'prod', label: 'job', ttlSeconds: 600 });

  const made = await ctx.client.tokens.create({ name: 'limited', scope: 'exec', imps: ['dev-*'] });

  const limited = createImpClient({
    url: 'http://impd.test',
    token: made.secret,
    fetch: ctx.sendToImpd,
  });

  expect(
    limited.leases.acquire({ name: 'dev-a', label: 'job', ttlSeconds: 60 }),
  ).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  const decision = await waitFor(() => {
    const found = ctx.events.find(
      (event) => event.ev === 'GovernorDecision' && event.decision === 'refused',
    );

    expect(found).toBeDefined();

    return found;
  });

  expect(decision).toMatchObject({ neededMib: 100, protectedCount: 2 });
});

test('it holds the imp until the longest of its leases ends', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'short', ttlSeconds: 60 });
  await ctx.client.leases.acquire({ name: 'dev', label: 'long', ttlSeconds: 600 });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.holdUntil).toStrictEqual(new Date(ctx.clock.nowMs + 600_000));
});

test('it moves the imp’s hold out when a renew makes a lease the longest', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'short', ttlSeconds: 60 });
  await ctx.client.leases.acquire({ name: 'dev', label: 'long', ttlSeconds: 600 });
  await ctx.client.leases.renew({ name: 'dev', label: 'short', ttlSeconds: 900 });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.holdUntil).toStrictEqual(new Date(ctx.clock.nowMs + 900_000));
});

test('it moves the imp’s hold in when the longest lease is released', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'short', ttlSeconds: 900 });
  await ctx.client.leases.acquire({ name: 'dev', label: 'long', ttlSeconds: 600 });
  await ctx.client.leases.release({ name: 'dev', label: 'short' });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.holdUntil).toStrictEqual(new Date(ctx.clock.nowMs + 600_000));
});

test('it keeps the imp held by its leases when the caller’s hold is released', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'long', ttlSeconds: 600 });
  await ctx.client.imps.hold({ name: 'dev', seconds: 30 });
  await ctx.client.imps.hold({ name: 'dev', seconds: 0 });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.holdUntil).toStrictEqual(new Date(ctx.clock.nowMs + 600_000));
});

test('it holds the imp by root’s hold alone after a forced sleep ends its leases', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const made = await ctx.client.tokens.create({ name: 'a', scope: 'exec' });

  const a = createImpClient({ url: 'http://impd.test', token: made.secret, fetch: ctx.sendToImpd });

  await a.leases.acquire({ name: 'dev', label: 'long', ttlSeconds: 600 });
  await ctx.client.imps.hold({ name: 'dev', seconds: 30 });
  await ctx.client.imps.sleep({ name: 'dev', force: true });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.holdUntil).toStrictEqual(new Date(ctx.clock.nowMs + 30_000));
});

test('it keeps the leases and emits no release when a forced sleep fails', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  ctx.vmm.queue('sleep', 'fail');

  expect(ctx.client.imps.sleep({ name: 'dev', force: true })).rejects.toThrow();

  // a later write's event: every event of the failed sleep came before it
  await ctx.client.imps.hold({ name: 'dev', seconds: 0 });

  await waitFor(() => {
    expect(ctx.events).toPartiallyContain({ ev: 'ImpChanged', reason: 'held' });
  });

  const leases = await ctx.client.leases.list({ name: 'dev' });
  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(leases.map((lease) => lease.owner.label)).toStrictEqual(['job']);
  expect(imp.holdUntil).toStrictEqual(new Date(ctx.clock.nowMs + 60_000));
  expect(ctx.events).not.toPartiallyContain({ ev: 'ImpChanged', reason: 'released' });
  expect(ctx.rpcFailures).toMatchObject([{ message: 'snapshot failed' }]);
});

test('it answers a sleep of a leased imp the shutdown pass slept', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 600 });

  // as after an impd restart: the shutdown pass slept it and kept the lease
  await ctx.impd.imps.sleepAllImps();

  const asleep = await ctx.client.imps.sleep({ name: 'dev' });

  expect(asleep.state).toBe('sleeping');
});

test('it answers a stop of a stopped imp another owner leases and keeps the lease', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.stop({ name: 'dev' });

  // a lease another owner holds on the stopped imp
  await writeLease(
    ctx.db,
    {
      impId: created.id,
      principal: 'token:other',
      label: 'job',
      display: 'other',
      until: new Date(ctx.clock.nowMs + 600_000),
      createdAt: new Date(ctx.clock.nowMs),
    },
    { at: ctx.clock.nowMs, reason: null },
  );

  const stopped = await ctx.client.imps.stop({ name: 'dev' });
  const leases = await listLeases(ctx.db, ctx.clock.nowMs);

  expect(stopped.state).toBe('stopped');
  expect(leases.map((lease) => lease.principal)).toStrictEqual(['token:other']);
});

test('it emits held on hold 0 even when it releases nothing', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.hold({ name: 'dev', seconds: 0 });

  const held = await waitFor(() => {
    const found = ctx.events.filter(
      (event) => event.ev === 'ImpChanged' && event.reason === 'held',
    );

    expect(found).not.toBeEmpty();

    return found;
  });

  expect(held).toMatchObject([{ ev: 'ImpChanged', reason: 'held' }]);
});

test('it names an imp’s lease owners from the presenter’s one read', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  const presented = await ctx.impd.imps.getImp('dev');

  expect(readPresentedLeases(presented)?.map((lease) => lease.label)).toStrictEqual(['job']);
});
