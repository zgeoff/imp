import { expect, test } from 'bun:test';
import { createCheckpoint } from '../db/checkpoints';
import { createImp } from '../db/imps';
import { setupTestDatabase } from '../db/test-database';
import { createDiskUsageCache } from './disk-usage-cache';
import type { DiskUsageReport, StorageBackend } from './storage-backend';

type MeasureUsage = StorageBackend['measureUsage'];

async function setupCache(measureUsage: MeasureUsage) {
  const ctx = await setupTestDatabase();

  const logs: string[] = [];

  const imp = await createImp(ctx.db, {
    name: 'dev',
    imageId: ctx.image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  await createCheckpoint(ctx.db, { id: 'cp-1', impId: imp.id, label: null, sizeBytes: null });

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: { measureUsage },
    log: (message) => {
      logs.push(message);
    },
    now: () => new Date(5000),
  });

  return Object.assign(ctx, { imp, cache, logs });
}

function buildReport(impId: string, isPartial: boolean): DiskUsageReport {
  return {
    imps: new Map([[impId, { exclusiveBytes: 10, sharedBytes: 20, isUpperBound: false }]]),
    isPartial,
  };
}

test('a pass measures every imp with its checkpoints and keeps the result', async () => {
  const asked: Parameters<MeasureUsage>[0][] = [];

  await using ctx = await setupCache((imps) => {
    asked.push(imps);

    return Promise.resolve(buildReport(imps[0]?.impId ?? '', true));
  });

  expect(ctx.cache.read(ctx.imp.id)).toBeUndefined();

  await ctx.cache.runPass();

  expect(asked).toEqual([[{ impId: ctx.imp.id, checkpointIds: ['cp-1'] }]]);
  expect(ctx.cache.readExclusiveTotal()).toBe(10);

  expect(ctx.cache.read(ctx.imp.id)).toEqual({
    exclusiveBytes: 10,
    sharedBytes: 20,
    isUpperBound: false,
    isPartial: true,
    measuredAt: new Date(5000),
  });
});

test('passes run one at a time, and a failed one keeps the last result', async () => {
  const gate = Promise.withResolvers<DiskUsageReport>();
  const state = { calls: 0 };

  await using ctx = await setupCache((imps) => {
    state.calls += 1;

    if (state.calls === 1) {
      return Promise.resolve(buildReport(imps[0]?.impId ?? '', false));
    }

    return gate.promise;
  });

  await ctx.cache.runPass();

  const first = ctx.cache.runPass();
  const second = ctx.cache.runPass();

  gate.reject(new Error('pool gone'));

  await Promise.all([first, second]);

  expect(state.calls).toBe(2);
  expect(ctx.cache.read(ctx.imp.id)?.isPartial).toBeFalse();
  expect(ctx.logs).toEqual(['impd: disk usage: pool gone']);
});

test('an imp a cut-short pass did not reach keeps its last count', async () => {
  const state = { calls: 0 };

  await using ctx = await setupCache((imps) => {
    state.calls += 1;

    const report = buildReport(imps[0]?.impId ?? '', state.calls > 1);

    // the second pass reached no imp
    const cut = { imps: new Map(), isPartial: true };
    const answer = state.calls === 1 ? report : cut;

    return Promise.resolve(answer);
  });

  await ctx.cache.runPass();
  await ctx.cache.runPass();

  expect(ctx.cache.read(ctx.imp.id)).toMatchObject({ exclusiveBytes: 10, isPartial: false });
});
