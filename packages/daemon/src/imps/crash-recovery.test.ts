import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { findImpByName } from '../db/imps';
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
