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
import { openDatabase } from '../db/open-database';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { buildImpPaths } from './data-layout';
import { readLiveStorage } from './read-live-storage';
import { createStorageGate } from './storage-gate';
import { createStorageGc } from './storage-gc';
import { createFakeZfs } from './zfs/fake-zfs';
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

test('the hourly pass keeps every orphan of a lost database and logs each once a pass', async () => {
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

  // an empty database over the disks and checkpoints of two imps
  for (const impId of ['a', 'b']) {
    await ctx.storage.createImpDisk(impId, { kind: 'empty' });
    await ctx.storage.createCheckpoint(impId, `cp-${impId}`);
  }

  await gc.runScheduled();
  await gc.runScheduled();

  for (const impId of ['a', 'b']) {
    expect(existsSync(ctx.storage.resolveImpPaths(impId).disk)).toBeTrue();
    expect(readdirSync(ctx.storage.resolveImpPaths(impId).checkpointsDir)).toEqual([`cp-${impId}`]);
  }

  expect(logs.filter((line) => line.includes('kept orphan imp a '))).toHaveLength(2);
  expect(logs.filter((line) => line.includes('kept orphan imp b '))).toHaveLength(2);
  expect(logs.filter((line) => line.includes('kept 2 orphans'))).toHaveLength(2);
  expect(logs).toHaveLength(6);
});

test('the hourly pass on ZFS keeps the disks of a lost database, checkpoints and all', async () => {
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
    await backend.createImpDisk('a', { kind: 'empty' });
    await backend.createCheckpoint('a', 'cp-1');

    const gc = createStorageGc({
      db,
      storage: backend,
      storageGate: createStorageGate(),
      log: (message) => {
        logs.push(message);
      },
    });

    await gc.runScheduled();
    await backend.waitForReclaim();

    expect(fake.listDatasets()).toContain('tank/imp/disks/a');
    expect(fake.listSnapshots()).toEqual(['tank/imp/disks/a@cp-1']);
    expect(fake.isDeferred('tank/imp/disks/a@cp-1')).toBeFalse();
    expect(logs).toHaveLength(2);

    expect(logs[0]).toMatch(
      /^impd: gc: kept orphan imp a \(tank\/imp\/disks\/a\): .+snapshots: cp-1$/,
    );
  } finally {
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
