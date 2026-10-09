import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { buildSessionValue } from '../auth/session-cookie';
import { ROOT_TOKEN_ID } from '../auth/token-store';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import type { ImpdDeps } from '../create-impd';
import { listApiCalls } from '../db/api-audit';
import { createImage } from '../db/images';
import { subscribeImpWrites } from '../db/imp-write-feed';
import { findImpByName } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildMockGovernorDecision } from '../test-utils/build-mock-governor-decision';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { readInBackground } from '../test-utils/read-in-background';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'imp-events-'));

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
  const logs: string[] = [];

  // a frozen clock, far from the wall clock, that the session cookies read
  const clock = { nowMs: Date.UTC(2026, 0, 1) };

  const deps: ImpdDeps = {
    db,

    // the bearer the test's client sends, and the key of its session cookies
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
    log: (message) => {
      logs.push(message);
    },
    now: () => clock.nowMs,

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

  const impd = await createImpd(config, deps);

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
  });

  stack.defer(() => {
    impd.diskUsage.stop();
  });

  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: { authorization: 'Bearer root-token' },
    fetch: (request) => impd.api.app.handle(request),
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(link);

  return { config, db, dataDir, deps, vmm, logs, clock, impd, client, stack };
}

test('it sends the snapshot, then each change with its reason', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'old', image: 'ubuntu' });

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });
  await ctx.client.imps.destroy({ name: 'dev' });

  await waitFor(() => {
    if (!stream.items.some((event) => event.ev === 'ImpRemoved')) {
      throw new Error('no ImpRemoved yet');
    }
  });

  controller.abort();

  await stream.ended;

  expect(stream.items).toMatchObject([
    { ev: 'ImpAdded', reason: 'snapshot', imp: { name: 'old' } },
    { ev: 'ImpAdded', reason: 'created', imp: { name: 'dev' } },
    { ev: 'GovernorDecision', decision: 'admitted', name: 'dev' },
    {
      ev: 'ImpChanged',
      reason: 'booted',
      imp: { name: 'dev' },
      detail: { durationMs: expect.toBeNumber() },
    },
    {
      ev: 'ImpChanged',
      reason: 'slept',
      imp: { name: 'dev' },
      detail: { durationMs: expect.toBeNumber(), trigger: 'requested' },
    },
    { ev: 'GovernorDecision', decision: 'admitted', name: 'dev' },
    {
      ev: 'ImpChanged',
      reason: 'woke',
      imp: { name: 'dev' },
      detail: { durationMs: expect.toBeNumber() },
    },
    { ev: 'ImpRemoved', imp: { name: 'dev' } },
  ]);
});

test('it counts a young guest’s wait before a sleep in the slept event’s prepareMs', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);

  // 200 ms short of IMP_SLEEP_MIN_GUEST_UPTIME_MS's 1500 ms default: the
  // sleep waits the rest on the wall clock before it pauses the VM
  ctx.vmm.setGuestUptime(1300);

  await ctx.client.imps.sleep({ name: 'dev' });

  const slept = await waitFor(() => {
    const found = stream.items.find(
      (event) => event.ev === 'ImpChanged' && event.reason === 'slept',
    );

    invariant(found, 'no slept event yet');

    return found;
  });

  controller.abort();

  expect(slept).toMatchObject({
    detail: { prepareMs: expect.toSatisfy((ms: number) => ms >= 200) },
  });
});

test('it sends a repaired event when a check finds an imp’s VM gone', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dead', image: 'ubuntu' });

  const dead = await findImpByName(ctx.db, 'dead');

  invariant(dead?.pid);

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);

  ctx.vmm.alive.delete(dead.pid);

  await ctx.client.imps.list();

  const repaired = await waitFor(() => {
    const found = stream.items.find(
      (event) => event.ev === 'ImpChanged' && event.reason === 'repaired',
    );

    invariant(found, 'no repaired event yet');

    return found;
  });

  controller.abort();

  expect(repaired).toMatchObject({ imp: { name: 'dead' } });
});

test('it reports an adopted change when a restarted impd adopts a running VM', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'alive', image: 'ubuntu' });

  // the restarted impd adopts during its boot, before a stream on it could
  // open, and the first impd's runner no longer answers once it is replaced:
  // the write each impd's publisher turns into the event is what shows
  const changes: string[] = [];

  const unsubscribe = subscribeImpWrites(ctx.db, (write) => {
    if (write.kind === 'changed') {
      changes.push(`${write.reason} ${write.imp.name}`);
    }
  });

  onTestFinished(unsubscribe);

  // the first impd still holds its resolver's port in this process
  const restarted = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    { ...ctx.deps, vms: ctx.vmm.startGeneration() },
  );

  ctx.stack.defer(() => restarted.broker.stop());

  ctx.stack.defer(() => {
    restarted.egress.stop();
  });

  ctx.stack.defer(() => {
    restarted.diskUsage.stop();
  });

  expect(changes).toContain('adopted alive');
});

test('it puts a secret’s value in no event and no audit row', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_secretvalue0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.imps.sleep({ name: 'dev' });

  await waitFor(() => {
    if (!stream.items.some((event) => event.ev === 'ImpChanged' && event.reason === 'slept')) {
      throw new Error('no slept event yet');
    }
  });

  controller.abort();

  // each audit row lands after its call's answer
  const calls = await waitFor(async () => {
    const listed = await listApiCalls(ctx.db, null, 100, null);

    if (listed.length < 4) {
      throw new Error(`${String(listed.length)} audit rows`);
    }

    return listed;
  });

  expect(JSON.stringify(stream.items)).not.toInclude('ghp_secretvalue0123456789');
  expect(JSON.stringify(calls)).not.toInclude('ghp_secretvalue0123456789');

  // impd's clock is frozen, so every call takes 0 ms at the same time
  expect(calls).toStrictEqual([
    {
      procedure: 'imps.sleep',
      imp: 'dev',
      actor: 'token',
      actorName: 'root',
      at: new Date(Date.UTC(2026, 0, 1)),
      durationMs: 0,
      outcome: 'ok',
    },
    {
      procedure: 'grants.add',
      imp: 'dev',
      actor: 'token',
      actorName: 'root',
      at: new Date(Date.UTC(2026, 0, 1)),
      durationMs: 0,
      outcome: 'ok',
    },
    {
      procedure: 'secrets.add',
      actor: 'token',
      actorName: 'root',
      at: new Date(Date.UTC(2026, 0, 1)),
      durationMs: 0,
      outcome: 'ok',
    },
    {
      procedure: 'imps.create',
      imp: 'dev',
      actor: 'token',
      actorName: 'root',
      at: new Date(Date.UTC(2026, 0, 1)),
      durationMs: 0,
      outcome: 'ok',
    },
  ]);
});

test('it ends a dashboard stream at the session’s expiry', async () => {
  const ctx = await setupTest();

  // a session that ends a millisecond after the test's frozen now
  const dashboard: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: {
        cookie: `imp_session=${buildSessionValue('root-token', { tokenId: ROOT_TOKEN_ID, expiresAt: ctx.clock.nowMs + 1 })}`,
        'sec-fetch-site': 'same-origin',
      },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  const events = await dashboard.events.stream();

  const stream = readInBackground(events);

  const ended = await stream.ended;

  expect(ended).toBeNull();
});

test('it ends a dashboard stream at any logout, and leaves a token’s stream open', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const dashboard: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: {
        cookie: `imp_session=${buildSessionValue('root-token', { tokenId: ROOT_TOKEN_ID, expiresAt: ctx.clock.nowMs + 60_000 })}`,
        'sec-fetch-site': 'same-origin',
      },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  const dashboardEvents = await dashboard.events.stream();

  const dashboardStream = readInBackground(dashboardEvents);

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const tokenEvents = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const tokenStream = readInBackground(tokenEvents);

  const logout = await ctx.impd.api.app.handle(
    new Request('http://impd.test/auth/logout', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    }),
  );

  const dashboardEnded = await dashboardStream.ended;

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  await waitFor(() => {
    if (!tokenStream.items.some((event) => event.ev === 'ImpAdded')) {
      throw new Error('no ImpAdded yet');
    }
  });

  controller.abort();

  expect(logout.status).toBe(204);
  expect(dashboardEnded).toBeNull();

  expect(tokenStream.items[0]).toMatchObject({
    ev: 'ImpAdded',
    reason: 'created',
    imp: { name: 'dev' },
  });
});

test('it records a dashboard session’s calls in the audit log as the dashboard’s', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const dashboard: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: {
        cookie: `imp_session=${buildSessionValue('root-token', { tokenId: ROOT_TOKEN_ID, expiresAt: ctx.clock.nowMs + 60_000 })}`,
        'sec-fetch-site': 'same-origin',
      },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  await dashboard.imps.stop({ name: 'dev' });

  // each audit row lands after its call's answer
  const calls = await waitFor(async () => {
    const listed = await listApiCalls(ctx.db, null, 100, null);

    if (listed.length < 2) {
      throw new Error(`${String(listed.length)} audit rows`);
    }

    return listed;
  });

  expect(calls).toMatchObject([
    { procedure: 'imps.stop', actor: 'dashboard' },
    { procedure: 'imps.create', actor: 'token' },
  ]);
});

test('it drops an event that fails the schema and goes on', async () => {
  const ctx = await setupTest();

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);
  const good = buildMockGovernorDecision({ name: 'good' });
  const after = buildMockGovernorDecision({ name: 'after' });

  // no imp is named with a space
  ctx.impd.imps.events.publish(buildMockGovernorDecision({ name: 'boot template' }));
  ctx.impd.imps.events.publish(good);

  await waitFor(() => {
    if (stream.items.length === 0) {
      throw new Error('no event yet');
    }
  });

  // a stream that ended at the bad event would never send this one
  ctx.impd.imps.events.publish(after);

  await waitFor(() => {
    if (stream.items.length < 2) {
      throw new Error('one event so far');
    }
  });

  controller.abort();

  expect(stream.items).toStrictEqual([good, after]);

  expect(ctx.logs.filter((line) => line.includes('fail the event schema'))).toStrictEqual([
    'impd: dropped 1 GovernorDecision event(s) that fail the event schema; the latest at name: must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  ]);
});

test('it drops a snapshot imp that fails the schema and goes on', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'bad', image: 'ubuntu' });
  await ctx.client.imps.create({ name: 'good', image: 'ubuntu' });

  // a row no create would write
  await ctx.db.updateTable('imps').set({ name: 'Bad Name' }).where('name', '=', 'bad').execute();

  const controller = new AbortController();

  onTestFinished(() => {
    controller.abort();
  });

  const events = await ctx.client.events.stream(undefined, { signal: controller.signal });

  const stream = readInBackground(events);
  const later = buildMockGovernorDecision({ name: 'later' });

  await waitFor(() => {
    if (stream.items.length === 0) {
      throw new Error('no snapshot yet');
    }
  });

  // a stream that ended at the bad imp would never send this one
  ctx.impd.imps.events.publish(later);

  await waitFor(() => {
    if (stream.items.length < 2) {
      throw new Error('one event so far');
    }
  });

  controller.abort();

  expect(stream.items).toMatchObject([
    { ev: 'ImpAdded', reason: 'snapshot', imp: { name: 'good' } },
    later,
  ]);
});
