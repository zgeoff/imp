import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { findImpByName } from '../db/imps';
import { readSnapshotMeta, writeSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import { buildTestApp, findBrokenInvariants, setupImpTest } from './test-imps';

// impd killed at the points a sleep, a wake or a start can be cut, and the
// next impd's reconcile

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }

    await Bun.sleep(1);
  }
}

async function setupCrashTest() {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');

  const findPaths = async (name: string) => {
    const imp = await findImpByName(ctx.db, name);

    return buildImpPaths(ctx.dataDir, imp?.id ?? '');
  };

  return { ...ctx, client: buildTestApp(ctx, ctx).client, findPaths };
}

test('impd killed after a sleep renamed its files, before meta.json, leaves the imp stopped', async () => {
  await using ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });

  // an earlier sleep leaves a snapshot and its meta.json behind
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  const sleeping = ctx.fake.hold('sleep');

  void ctx.client.imps.sleep({ name: 'dev' });

  await sleeping.reached;

  // the old impd's sleep writes and renames its files, then never returns
  const impd = ctx.restartImpd();

  sleeping.release();

  const paths = await ctx.findPaths('dev');

  // the fake kills the VM, then writes and renames in the same turn
  await waitUntil(() => ctx.fake.alive.size === 0);

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(existsSync(paths.vmstate)).toBeTrue();
  expect(existsSync(paths.snapshotMeta)).toBeFalse();
  expect(imp?.state).toBe('stopped');
  expect(broken).toEqual([]);
});

test('a good wake drops meta.json, so a VM that dies later does not count as asleep', async () => {
  await using ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const asleep = existsSync(paths.snapshotMeta);

  await ctx.client.imps.wake({ name: 'dev' });

  expect(asleep).toBeTrue();
  expect(existsSync(paths.snapshotMeta)).toBeFalse();
});

test('a VM a cut sleep left paused is resumed, and the half-written files go', async () => {
  await using ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });

  const sleeping = ctx.fake.hold('sleep');

  void ctx.client.imps.sleep({ name: 'dev' });

  await sleeping.reached;

  const impd = ctx.restartImpd();

  const paths = await ctx.findPaths('dev');
  const running = await findImpByName(ctx.db, 'dev');

  const pid = running?.pid ?? 0;

  // the snapshot the cut sleep was writing
  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(`${paths.vmstate}.new`, 'partial');
  writeFileSync(`${paths.memFile}.new`, 'partial');

  const paused = ctx.fake.readState(pid);

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(paused).toBe('Paused');
  expect(ctx.fake.readState(pid)).toBe('Running');
  expect(imp).toMatchObject({ state: 'running', pid });
  expect(existsSync(`${paths.vmstate}.new`)).toBeFalse();
  expect(existsSync(`${paths.memFile}.new`)).toBeFalse();
});

test('a VM a cut wake left running is adopted with its memory', async () => {
  await using ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  // the wake loaded the snapshot; impd died before the record
  const pid = ctx.fake.spawnOrphan({ paths });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(imp).toMatchObject({ state: 'running', pid });
  expect(existsSync(paths.snapshotMeta)).toBeFalse();
  expect(broken).toEqual([]);
});

test('a VM a cut wake left before its load is killed, and the snapshot stays', async () => {
  await using ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const pid = ctx.fake.spawnOrphan({ paths, state: 'Not started' });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.alive.has(pid)).toBeFalse();
  expect(imp?.state).toBe('sleeping');
  expect(existsSync(paths.snapshotMeta)).toBeTrue();
});

test('a VM a cut wake left whose agent does not answer is killed, and the imp boots cold', async () => {
  await using ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const pid = ctx.fake.spawnOrphan({ paths });

  ctx.fake.queue('agentReady', 'fail');

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(ctx.fake.alive.has(pid)).toBeFalse();
  expect(imp?.state).toBe('stopped');
  expect(existsSync(paths.snapshotMeta)).toBeFalse();
  expect(broken).toEqual([]);
});

test('a VM a cut wake left with another agent than the snapshot recorded is killed', async () => {
  await using ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const meta = readSnapshotMeta(paths);

  if (meta === null) {
    throw new Error('no snapshot');
  }

  writeSnapshotMeta(paths, { ...meta, agentVersion: '0.0.1' });

  const pid = ctx.fake.spawnOrphan({ paths });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.alive.has(pid)).toBeFalse();
  expect(imp?.state).toBe('stopped');
});

test('a second VM on a running imp socket is killed, and the one on the record stays', async () => {
  await using ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });

  const paths = await ctx.findPaths('dev');
  const running = await findImpByName(ctx.db, 'dev');

  const owned = running?.pid ?? 0;
  const second = ctx.fake.spawnOrphan({ paths });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.alive.has(second)).toBeFalse();
  expect(ctx.fake.alive.has(owned)).toBeTrue();
  expect(imp).toMatchObject({ state: 'running', pid: owned });
});

test('a start cut before its pid file leaves a VM only /proc shows, and it is killed', async () => {
  await using ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const pid = ctx.fake.spawnOrphan({ paths, pidFile: false });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.alive.has(pid)).toBeFalse();
  expect(imp?.state).toBe('stopped');
});

test('a VM on the socket of an imp with no record is killed', async () => {
  await using ctx = await setupCrashTest();

  const pid = ctx.fake.spawnOrphan({ paths: buildImpPaths(ctx.dataDir, 'gone') });

  // a socket outside the data dir is not impd's to touch
  const foreign = ctx.fake.spawnOrphan({ paths: buildImpPaths('/elsewhere', 'gone') });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  expect(ctx.fake.alive.has(pid)).toBeFalse();
  expect(ctx.fake.alive.has(foreign)).toBeTrue();
});
