import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { buildImpPaths } from './data-layout';

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

test('a GC removes what no row names, and a dry run only lists it', async () => {
  await using ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');

  const app = buildTestApp(ctx, ctx);

  const dev = await app.client.imps.create({ name: 'dev' });

  // what a destroy that crashed after its row went leaves
  const lost = buildImpPaths(ctx.dataDir, 'lost');

  mkdirSync(lost.dir, { recursive: true });
  writeFileSync(lost.disk, 'disk');

  const listed = await app.client.system.gc({ dryRun: true });

  expect(listed).toEqual({ dryRun: true, dropped: [{ kind: 'imp', id: 'lost' }] });
  expect(existsSync(lost.disk)).toBeTrue();

  const removed = await app.client.system.gc({});

  expect(removed).toEqual({ dryRun: false, dropped: [{ kind: 'imp', id: 'lost' }] });
  expect(readdirSync(join(ctx.dataDir, 'imps'))).toEqual([dev.id]);
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
