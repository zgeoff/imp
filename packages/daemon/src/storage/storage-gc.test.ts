import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { createSecretFiles } from '../broker/secret-files';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import type { ImpdDeps } from '../create-impd';
import { createImage } from '../db/images';
import { openDatabase } from '../db/open-database';
import { runChecked } from '../process/run-command';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { buildStubZfs } from '../test-utils/build-stub-zfs';
import { createTestDatabase } from '../test-utils/create-test-database';
import { findFreePorts } from '../test-utils/find-free-ports';
import { buildImpPaths, buildSystemDrivePath, buildSystemDrivesDir } from './data-layout';
import { readLiveStorage } from './read-live-storage';
import { createStorageGate } from './storage-gate';
import { createStorageGc } from './storage-gc';
import { createXfsBackend } from './xfs-backend';
import { createZfsBackend } from './zfs/zfs-backend';

interface SetupOptions {
  // copies a disk or checkpoint file; a test holds one to catch storage made
  // before its row
  readonly cloneFile?: (source: string, target: string) => Promise<void>;
}

async function setupTest(options: SetupOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'storage-gc-'));

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
  const cgroups = buildStubCpuCgroups();

  const storage = createXfsBackend({
    dataDir,

    // sweep lines this suite reads from the GC's own log instead
    log: () => {},

    // a disk is a sparse file of the imp's full size, so a copy keeps the holes
    cloneFile:
      options.cloneFile ??
      (async (source, target) => {
        await runChecked(['cp', '--sparse=always', source, target]);
      }),
  });

  const deps: ImpdDeps = {
    db,

    // the bearer the test's client sends
    rootToken: 'root-token',
    storage,

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

    // boot and API lines this suite does not read
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
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: () =>
      Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] }),
    cgroups: cgroups.cgroups,
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

  return { db, dataDir, storage, vmm, impd, client };
}

test('it lists what a sweep would drop and keep in a dry run, and removes nothing', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  // a disk no row names: a lost database, or a destroy that crashed after
  // its row went
  const lost = buildImpPaths(ctx.dataDir, 'lost');

  await mkdir(lost.dir, { recursive: true });
  await writeFile(lost.disk, 'disk');

  // what a destroy leaves once the disk is gone
  const done = buildImpPaths(ctx.dataDir, 'done');

  await mkdir(done.runDir, { recursive: true });

  const listed = await ctx.client.system.gc({ dryRun: true });

  expect(listed).toMatchObject({
    dryRun: true,
    dropped: [{ kind: 'imp', id: 'done' }],
    kept: [{ kind: 'imp', id: 'lost', location: lost.dir }],
  });

  expect(existsSync(done.dir)).toBeTrue();
});

test('it removes what a destroy left and keeps an imp no row names', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const dev = await ctx.client.imps.create({ name: 'dev' });

  const lost = buildImpPaths(ctx.dataDir, 'lost');

  await mkdir(lost.dir, { recursive: true });
  await writeFile(lost.disk, 'disk');
  await mkdir(buildImpPaths(ctx.dataDir, 'done').runDir, { recursive: true });

  const swept = await ctx.client.system.gc({});

  expect(swept).toMatchObject({
    dryRun: false,
    dropped: [{ kind: 'imp', id: 'done' }],
    kept: [{ kind: 'imp', id: 'lost', location: lost.dir }],
  });

  expect(readdirSync(join(ctx.dataDir, 'imps'))).toIncludeSameMembers([dev.id, 'lost']);
});

test('it lists an imp no row names as dropped in a dry run with orphans, and keeps its disk', async () => {
  const ctx = await setupTest();

  const lost = buildImpPaths(ctx.dataDir, 'lost');

  await mkdir(lost.dir, { recursive: true });
  await writeFile(lost.disk, 'disk');

  const listed = await ctx.client.system.gc({ dryRun: true, orphans: true });

  expect(listed).toStrictEqual({ dryRun: true, dropped: [{ kind: 'imp', id: 'lost' }], kept: [] });
  expect(existsSync(lost.disk)).toBeTrue();
});

test('it removes an imp no row names when asked for orphans, and keeps a live imp', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const dev = await ctx.client.imps.create({ name: 'dev' });

  const lost = buildImpPaths(ctx.dataDir, 'lost');

  await mkdir(lost.dir, { recursive: true });
  await writeFile(lost.disk, 'disk');

  const removed = await ctx.client.system.gc({ orphans: true });

  expect(removed).toStrictEqual({
    dryRun: false,
    dropped: [{ kind: 'imp', id: 'lost' }],
    kept: [],
  });

  expect(readdirSync(join(ctx.dataDir, 'imps'))).toStrictEqual([dev.id]);
});

test('it keeps every orphan of a lost database through start, the hourly pass and imp gc', async () => {
  const ctx = await setupTest();

  const log = mock<(message: string) => void>();

  const gc = createStorageGc({
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    log,
  });

  // an empty database over an image, and the disks, checkpoints and memory
  // snapshots of two imps
  await ctx.storage.createImage('sha256:old', async (dir) => {
    await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
  });

  for (const impId of ['a', 'b']) {
    const paths = ctx.storage.resolveImpPaths(impId);

    await ctx.storage.createImpDisk(impId, { kind: 'empty' });
    await ctx.storage.createCheckpoint(impId, `cp-${impId}`);
    await Bun.write(paths.vmstate, 'vmstate');
    await Bun.write(paths.snapshotMeta, '{}');
  }

  const a = ctx.storage.resolveImpPaths('a');
  const b = ctx.storage.resolveImpPaths('b');

  const live = await readLiveStorage(ctx.db);

  await ctx.storage.start(live);
  await gc.runScheduled();
  await gc.runScheduled();

  const manual = await gc.runGc({ isDryRun: false, isOrphans: false });

  expect([
    a.disk,
    a.vmstate,
    a.snapshotMeta,
    join(a.checkpointsDir, 'cp-a'),
    b.disk,
    b.vmstate,
    b.snapshotMeta,
    join(b.checkpointsDir, 'cp-b'),
    join(ctx.dataDir, 'images', 'old', 'rootfs.ext4'),
  ]).toSatisfyAll((path: string) => existsSync(path));

  expect(manual.dropped).toStrictEqual([]);

  expect(manual.kept?.map((orphan) => `${orphan.kind} ${orphan.id}`)).toStrictEqual([
    'image old',
    'imp a',
    'imp b',
  ]);

  // each orphan once, then only the count while the set stays; imp gc
  // returns them instead
  const lines = log.mock.calls.map(([line]) => line);

  expect(lines.filter((line) => line.includes('kept orphan imp a '))).toHaveLength(1);
  expect(lines.filter((line) => line.includes('kept orphan imp b '))).toHaveLength(1);
  expect(lines.filter((line) => line.includes('kept orphan image old '))).toHaveLength(1);
  expect(lines.filter((line) => line.includes('kept 3 orphans'))).toHaveLength(2);
  expect(lines).toHaveLength(5);
});

test('it keeps what a lost database leaves on ZFS through the hourly pass and imp gc', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'storage-gc-zfs-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  const database = await createTestDatabase();

  const zfs = buildStubZfs({ root: 'tank/imp', rootDir: dataDir });
  const log = mock<(message: string) => void>();

  const backend = createZfsBackend({
    dataDir,
    root: 'tank/imp',
    run: zfs.run,
    readMounts: zfs.readMounts,
    readModuleVersion: () => '2.2.2-0ubuntu9',
    log: () => {},
  });

  const live = await readLiveStorage(database.db);

  await backend.start(live);
  await backend.createImage('sha256:old', () => Promise.resolve());
  await backend.createImpDisk('a', { kind: 'empty' });
  await backend.createCheckpoint('a', 'cp-1');
  await Bun.write(backend.resolveImpPaths('a').vmstate, 'vmstate');

  const gc = createStorageGc({
    db: database.db,
    storage: backend,
    storageGate: createStorageGate(),
    log,
  });

  await gc.runScheduled();

  const manual = await gc.runGc({ isDryRun: false, isOrphans: false });

  await backend.waitForReclaim();

  expect(manual.dropped).toStrictEqual([]);
  expect(zfs.listDatasets()).toIncludeAllMembers(['tank/imp/disks/a', 'tank/imp/images/old']);
  expect(zfs.listSnapshots()).toStrictEqual(['tank/imp/disks/a@cp-1', 'tank/imp/images/old@base']);
  expect(zfs.isDeferred('tank/imp/disks/a@cp-1')).toBeFalse();
  expect(existsSync(backend.resolveImpPaths('a').vmstate)).toBeTrue();
  expect(log).toHaveBeenCalledTimes(3);

  expect(log.mock.calls[0]?.[0]).toMatch(
    /^impd: gc: kept orphan imp a \(tank\/imp\/disks\/a\): .+snapshots: cp-1$/,
  );
});

test('it waits for a checkpoint whose clone exists before its row', async () => {
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();

  onTestFinished(() => {
    gate.resolve();
  });

  // clones pass until the checkpoint's, which holds once its file exists
  const hold = { reached: () => {}, gate: Promise.resolve() };

  const ctx = await setupTest({
    cloneFile: async (source, target) => {
      await runChecked(['cp', '--sparse=always', source, target]);

      hold.reached();

      await hold.gate;
    },
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev' });

  hold.reached = reached.resolve;
  hold.gate = gate.promise;

  const checkpoint = ctx.client.checkpoints.create({ name: 'dev', label: 'held' });

  await reached.promise;

  const gc = ctx.client.system.gc({});

  await waitFor(() => {
    expect(ctx.impd.storageGate.countWaiting()).toBe(1);
  });

  const inFlight = ctx.impd.storageGate.countInFlight();

  gate.resolve();

  const made = await checkpoint;
  const swept = await gc;
  const listed = await ctx.client.checkpoints.list({ name: 'dev' });

  expect(inFlight).toBe(1);
  expect(swept.dropped).toStrictEqual([]);
  expect(listed.map((one) => one.id)).toStrictEqual([made.id]);
});

test('it waits with orphans for an imp whose disk exists before its row', async () => {
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();

  onTestFinished(() => {
    gate.resolve();
  });

  const ctx = await setupTest({
    cloneFile: async (source, target) => {
      await runChecked(['cp', '--sparse=always', source, target]);

      // the disk's clone holds, after its file exists and before its row
      reached.resolve();

      await gate.promise;
    },
  });

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const created = ctx.client.imps.create({ name: 'dev' });

  await reached.promise;

  const gc = ctx.client.system.gc({ orphans: true });

  await waitFor(() => {
    expect(ctx.impd.storageGate.countWaiting()).toBe(1);
  });

  const inFlight = ctx.impd.storageGate.countInFlight();

  gate.resolve();

  const dev = await created;
  const swept = await gc;

  expect(inFlight).toBe(1);
  expect(swept).toStrictEqual({ dryRun: false, dropped: [], kept: [] });
  expect(existsSync(buildImpPaths(ctx.dataDir, dev.id).disk)).toBeTrue();
});

test('it waits with orphans for a destroy that holds the gate', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const dev = await ctx.client.imps.create({ name: 'dev' });

  const stop = ctx.vmm.hold('stop');

  onTestFinished(() => {
    stop.release();
  });

  const destroyed = ctx.client.imps.destroy({ name: 'dev' });

  await stop.reached;

  const gc = ctx.client.system.gc({ orphans: true });

  // the GC waits on the gate while the VM stops, before any file goes
  await waitFor(() => {
    expect(ctx.impd.storageGate.countWaiting()).toBe(1);
  });

  const inFlight = ctx.impd.storageGate.countInFlight();
  const diskWhileWaiting = existsSync(buildImpPaths(ctx.dataDir, dev.id).disk);

  stop.release();

  await destroyed;

  const swept = await gc;

  expect(inFlight).toBe(1);
  expect(diskWhileWaiting).toBeTrue();
  expect(swept).toStrictEqual({ dryRun: false, dropped: [], kept: [] });
  expect(readdirSync(join(ctx.dataDir, 'imps'))).toStrictEqual([]);
});

test('it refuses imp gc while operations keep storage busy', async () => {
  const database = await createTestDatabase();

  const storageGate = createStorageGate();
  const stuck = Promise.withResolvers<void>();

  onTestFinished(() => {
    stuck.resolve();
  });

  void storageGate.join(() => stuck.promise);

  const gc = createStorageGc({
    db: database.db,
    storage: { dropUnnamed: mock() },
    storageGate,
    log: mock<(message: string) => void>(),
    manualWaitMs: 0,
  });

  expect(gc.runGc({ isDryRun: false, isOrphans: false })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'storage is busy (1 operations in flight, a backup run among them perhaps); try again',
  });
});

test('it logs and skips the hourly pass while operations keep storage busy', async () => {
  const database = await createTestDatabase();

  const storageGate = createStorageGate();
  const stuck = Promise.withResolvers<void>();

  onTestFinished(() => {
    stuck.resolve();
  });

  void storageGate.join(() => stuck.promise);
  const dropUnnamed = mock();
  const log = mock<(message: string) => void>();

  const gc = createStorageGc({
    db: database.db,
    storage: { dropUnnamed },
    storageGate,
    log,
    scheduledWaitMs: 0,
  });

  await gc.runScheduled();

  expect(log).toHaveBeenCalledExactlyOnceWith(
    'impd: gc: storage stayed busy; the next pass tries again',
  );

  expect(dropUnnamed).not.toHaveBeenCalled();
});

// Secret values the broker kept aside (docs/guides/connectors.md#value-files)
// come only to a caller that asks with `secretFiles`: an older client does not
// know kind `secrets`. Only `removeSecretFiles` with `orphans` deletes them.
test('it leaves the secret values kept aside out of a GC that does not ask for them', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dataDir);

  files.write('late.b2', 'npm_LATE');
  files.keepOrphansExcept(new Set(), new Date('2026-10-04T05:30:00.000Z'));

  const unasked = await ctx.client.system.gc({ orphans: true });

  expect(unasked.kept).not.toPartiallyContain({ kind: 'secrets' });
  expect(unasked.dropped).not.toPartiallyContain({ kind: 'secrets' });
});

test('it lists the secret values kept aside when asked', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dataDir);

  files.write('late.b2', 'npm_LATE');

  const kept = files.keepOrphansExcept(new Set(), new Date('2026-10-04T05:30:00.000Z'));

  const listed = await ctx.client.system.gc({ secretFiles: true });

  invariant(kept.dir);

  expect(listed.kept?.filter((orphan) => orphan.kind === 'secrets')).toStrictEqual([
    {
      kind: 'secrets',
      id: '2026-10-04T05-30-00.000Z',
      location: kept.dir,
      bytes: 8,
      createdAt: new Date('2026-10-04T05:30:00.000Z'),
      snapshots: [],
      files: ['late.b2'],
    },
  ]);
});

test('it only lists the secret values kept aside when asked for orphans alone', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dataDir);

  files.write('late.b2', 'npm_LATE');

  const kept = files.keepOrphansExcept(new Set(), new Date('2026-10-04T05:30:00.000Z'));

  const orphans = await ctx.client.system.gc({ secretFiles: true, orphans: true });

  expect(orphans.kept).toPartiallyContain({ kind: 'secrets', id: '2026-10-04T05-30-00.000Z' });
  expect(orphans.dropped).not.toPartiallyContain({ kind: 'secrets' });

  invariant(kept.dir);

  expect(existsSync(kept.dir)).toBeTrue();
});

test('it lists the secret values kept aside as dropped in a dry run told to remove them', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dataDir);

  files.write('late.b2', 'npm_LATE');

  const kept = files.keepOrphansExcept(new Set(), new Date('2026-10-04T05:30:00.000Z'));

  const dry = await ctx.client.system.gc({
    secretFiles: true,
    removeSecretFiles: true,
    orphans: true,
    dryRun: true,
  });

  invariant(kept.dir);

  expect(dry.dropped).toContainEqual({ kind: 'secrets', id: '2026-10-04T05-30-00.000Z' });
  expect(existsSync(kept.dir)).toBeTrue();
});

test('it removes the secret values kept aside when told to with orphans', async () => {
  const ctx = await setupTest();

  const files = createSecretFiles(ctx.dataDir);

  files.write('late.b2', 'npm_LATE');

  const kept = files.keepOrphansExcept(new Set(), new Date('2026-10-04T05:30:00.000Z'));

  const removed = await ctx.client.system.gc({
    secretFiles: true,
    removeSecretFiles: true,
    orphans: true,
  });

  invariant(kept.dir);

  expect(removed.dropped).toContainEqual({ kind: 'secrets', id: '2026-10-04T05-30-00.000Z' });
  expect(existsSync(kept.dir)).toBeFalse();
  expect(files.listKept()).toStrictEqual([]);
});
