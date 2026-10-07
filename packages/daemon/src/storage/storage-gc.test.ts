import { expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretFiles } from '../broker/secret-files';
import { openDatabase } from '../db/open-database';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { createFakeZfs } from '../test-utils/build-stub-zfs';
import { buildImpPaths } from './data-layout';
import { readLiveStorage } from './read-live-storage';
import { createStorageGate } from './storage-gate';
import { createStorageGc } from './storage-gc';
import { createZfsBackend } from './zfs/zfs-backend';

// a clone that waits on `gate` when its target matches `held`
function buildHeldClone(held: string, gate: Promise<void>, reached: () => void) {
  return async (source: string, target: string): Promise<void> => {
    if (target.includes(held)) {
      reached();

      await gate;
    }

    copyFileSync(source, target);
  };
}

test('a GC keeps an imp no row names until asked for orphans, and a dry run only lists it', async () => {
  await using ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');

  const app = buildTestApp(ctx, ctx);

  const dev = await app.client.imps.create({ name: 'dev' });

  // a disk no row names: a lost database, or a destroy that crashed after
  // its row went
  const lost = buildImpPaths(ctx.dataDir, 'lost');

  mkdirSync(lost.dir, { recursive: true });
  writeFileSync(lost.disk, 'disk');

  // what a destroy leaves once the disk is gone
  mkdirSync(buildImpPaths(ctx.dataDir, 'done').runDir, { recursive: true });

  const listed = await app.client.system.gc({ dryRun: true });

  expect(listed.dropped).toEqual([{ kind: 'imp', id: 'done' }]);

  expect(listed.kept?.map((orphan) => [orphan.kind, orphan.id, orphan.location])).toEqual([
    ['imp', 'lost', lost.dir],
  ]);

  expect(existsSync(buildImpPaths(ctx.dataDir, 'done').dir)).toBeTrue();

  const swept = await app.client.system.gc({});

  expect(swept).toEqual({ ...listed, dryRun: false });
  expect(readdirSync(join(ctx.dataDir, 'imps')).toSorted()).toEqual([dev.id, 'lost'].toSorted());

  const orphans = await app.client.system.gc({ dryRun: true, orphans: true });

  expect(orphans).toEqual({ dryRun: true, dropped: [{ kind: 'imp', id: 'lost' }], kept: [] });
  expect(existsSync(lost.disk)).toBeTrue();

  const removed = await app.client.system.gc({ orphans: true });

  expect(removed).toEqual({ ...orphans, dryRun: false });
  expect(readdirSync(join(ctx.dataDir, 'imps'))).toEqual([dev.id]);
});

test('start, the hourly pass and imp gc keep every orphan of a lost database, logged once', async () => {
  await using ctx = await setupImpTest();

  const logs: string[] = [];

  const gc = createStorageGc({
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.storageGate,
    log: (message) => {
      logs.push(message);
    },
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

  const live = await readLiveStorage(ctx.db);

  await ctx.storage.start(live);
  await gc.runScheduled();
  await gc.runScheduled();

  const manual = await gc.runGc({ isDryRun: false, isOrphans: false });

  for (const impId of ['a', 'b']) {
    const paths = ctx.storage.resolveImpPaths(impId);

    expect(existsSync(paths.disk)).toBeTrue();
    expect(existsSync(paths.vmstate)).toBeTrue();
    expect(existsSync(paths.snapshotMeta)).toBeTrue();
    expect(readdirSync(paths.checkpointsDir)).toEqual([`cp-${impId}`]);
  }

  expect(existsSync(join(ctx.dataDir, 'images', 'old', 'rootfs.ext4'))).toBeTrue();
  expect(manual.dropped).toEqual([]);

  expect(manual.kept?.map((orphan) => `${orphan.kind} ${orphan.id}`)).toEqual([
    'image old',
    'imp a',
    'imp b',
  ]);

  // each orphan once, then only the count while the set stays; imp gc
  // returns them instead
  expect(logs.filter((line) => line.includes('kept orphan imp a '))).toHaveLength(1);
  expect(logs.filter((line) => line.includes('kept orphan image old '))).toHaveLength(1);
  expect(logs.filter((line) => line.includes('kept 3 orphans'))).toHaveLength(2);
  expect(logs).toHaveLength(5);
});

test('the hourly pass and imp gc on ZFS keep what a lost database leaves', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-gc-zfs-`);
  const fake = createFakeZfs({ root: 'tank/imp', rootDir: dataDir });
  const logs: string[] = [];

  const backend = createZfsBackend({
    dataDir,
    root: 'tank/imp',
    run: fake.run,
    readMounts: fake.readMounts,
    readModuleVersion: () => '2.2.2-0ubuntu9',
    log: () => {},
  });

  const db = await openDatabase(':memory:');

  try {
    const live = await readLiveStorage(db);

    await backend.start(live);
    await backend.createImage('sha256:old', () => Promise.resolve());
    await backend.createImpDisk('a', { kind: 'empty' });
    await backend.createCheckpoint('a', 'cp-1');
    await Bun.write(backend.resolveImpPaths('a').vmstate, 'vmstate');

    const gc = createStorageGc({
      db,
      storage: backend,
      storageGate: createStorageGate(),
      log: (message) => {
        logs.push(message);
      },
    });

    await gc.runScheduled();

    const manual = await gc.runGc({ isDryRun: false, isOrphans: false });

    await backend.waitForReclaim();

    expect(manual.dropped).toEqual([]);
    expect(fake.listDatasets()).toContain('tank/imp/disks/a');
    expect(fake.listDatasets()).toContain('tank/imp/images/old');
    expect(fake.listSnapshots()).toEqual(['tank/imp/disks/a@cp-1', 'tank/imp/images/old@base']);
    expect(fake.isDeferred('tank/imp/disks/a@cp-1')).toBeFalse();
    expect(existsSync(backend.resolveImpPaths('a').vmstate)).toBeTrue();
    expect(logs).toHaveLength(3);

    expect(logs[0]).toMatch(
      /^impd: gc: kept orphan imp a \(tank\/imp\/disks\/a\): .+snapshots: cp-1$/,
    );
  } finally {
    await db.destroy();

    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a GC waits for a checkpoint whose clone exists before its row', async () => {
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();

  await using ctx = await setupImpTest({
    cloneDisk: buildHeldClone('/checkpoints/', gate.promise, reached.resolve),
  });

  await ctx.createTestImage('ubuntu');

  const app = buildTestApp(ctx, ctx);

  await app.client.imps.create({ name: 'dev' });

  const checkpoint = app.client.checkpoints.create({ name: 'dev', label: 'held' });

  await reached.promise;

  const gc = app.client.system.gc({});

  // the GC waits on the gate while the clone holds
  await Bun.sleep(20);

  expect(ctx.storageGate.countInFlight()).toBe(1);

  gate.resolve();

  const made = await checkpoint;
  const swept = await gc;

  expect(swept.dropped).toEqual([]);

  const listed = await app.client.checkpoints.list({ name: 'dev' });

  expect(listed.map((one) => one.id)).toEqual([made.id]);
});

test('a GC with orphans waits for an imp whose disk exists before its row', async () => {
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();

  await using ctx = await setupImpTest({
    cloneDisk: buildHeldClone('/disk.ext4', gate.promise, reached.resolve),
  });

  await ctx.createTestImage('ubuntu');

  const app = buildTestApp(ctx, ctx);
  const created = app.client.imps.create({ name: 'dev' });

  await reached.promise;

  const gc = app.client.system.gc({ orphans: true });

  // the GC waits on the gate while the clone holds
  await Bun.sleep(20);

  expect(ctx.storageGate.countInFlight()).toBe(1);

  gate.resolve();

  const dev = await created;
  const swept = await gc;

  expect(swept).toEqual({ dryRun: false, dropped: [], kept: [] });
  expect(existsSync(buildImpPaths(ctx.dataDir, dev.id).disk)).toBeTrue();
});

test('a GC with orphans waits for a destroy that holds the gate', async () => {
  await using ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');

  const app = buildTestApp(ctx, ctx);

  const dev = await app.client.imps.create({ name: 'dev' });

  const stop = ctx.fake.hold('stop');
  const destroyed = app.client.imps.destroy({ name: 'dev' });

  await stop.reached;

  const gc = app.client.system.gc({ orphans: true });

  // the GC waits on the gate while the VM stops, before any file goes
  await Bun.sleep(20);

  expect(ctx.storageGate.countInFlight()).toBe(1);
  expect(existsSync(buildImpPaths(ctx.dataDir, dev.id).disk)).toBeTrue();

  stop.release();

  await destroyed;

  const swept = await gc;

  expect(swept).toEqual({ dryRun: false, dropped: [], kept: [] });
  expect(readdirSync(join(ctx.dataDir, 'imps'))).toEqual([]);
});

// Secret values the broker kept aside (docs/guides/connectors.md#value-files)
// come only to a caller that asks with `secretFiles`: an older client does not
// know kind `secrets`. Only `removeSecretFiles` with `orphans` deletes them.
test('a GC lists the secret values kept aside when asked, and removes them only when told to', async () => {
  await using ctx = await setupImpTest();

  const app = buildTestApp(ctx, ctx);
  const files = createSecretFiles(ctx.dataDir);

  files.write('late.b2', 'npm_LATE');

  const at = new Date('2026-10-04T05:30:00.000Z');

  const kept = files.keepOrphansExcept(new Set(), at);
  const id = '2026-10-04T05-30-00.000Z';

  const unasked = await app.client.system.gc({ orphans: true });

  expect(unasked.kept?.some((orphan) => orphan.kind === 'secrets')).toBe(false);
  expect(unasked.dropped.some((dropped) => dropped.kind === 'secrets')).toBe(false);

  const listed = await app.client.system.gc({ secretFiles: true });

  expect(listed.kept?.filter((orphan) => orphan.kind === 'secrets')).toEqual([
    {
      kind: 'secrets',
      id,
      location: kept.dir ?? '',
      bytes: 'npm_LATE'.length,
      createdAt: at,
      snapshots: [],
      files: ['late.b2'],
    },
  ]);

  // orphans alone retires disks and images, and only lists these
  const orphans = await app.client.system.gc({ secretFiles: true, orphans: true });

  expect(orphans.kept?.map((orphan) => orphan.id)).toContain(id);
  expect(orphans.dropped).not.toContainEqual({ kind: 'secrets', id });
  expect(existsSync(kept.dir ?? '')).toBe(true);

  const told = { secretFiles: true, removeSecretFiles: true, orphans: true };

  const dry = await app.client.system.gc({ ...told, dryRun: true });

  expect(dry.dropped).toContainEqual({ kind: 'secrets', id });
  expect(existsSync(kept.dir ?? '')).toBe(true);

  const removed = await app.client.system.gc(told);

  expect(removed.dropped).toContainEqual({ kind: 'secrets', id });
  expect(existsSync(kept.dir ?? '')).toBe(false);
  expect(files.listKept()).toEqual([]);
});
