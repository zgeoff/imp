import { expect, mock, onTestFinished, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { createCheckpoint } from '../db/checkpoints';
import { createImage } from '../db/images';
import { createImp } from '../db/imps';
import { buildMockImpDiskUsage } from '../test-utils/build-mock-imp-disk-usage';
import { createTestDatabase } from '../test-utils/create-test-database';
import { createDiskUsageCache } from './disk-usage-cache';
import type { DiskUsageReport, StorageBackend } from './storage-backend';

async function setupTest() {
  const database = await createTestDatabase();

  return { db: database.db };
}

test('it measures every imp with its checkpoints', async () => {
  const ctx = await setupTest();

  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imp = await createImp(ctx.db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  await createCheckpoint(ctx.db, { id: 'cp-1', impId: imp.id, label: null, sizeBytes: null });

  const measureUsage = mock<StorageBackend['measureUsage']>(() =>
    Promise.resolve({ imps: new Map(), isPartial: false }),
  );

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: { measureUsage },
    log: mock<(message: string) => void>(),
  });

  onTestFinished(() => {
    cache.stop();
  });

  await cache.runPass();

  expect(measureUsage).toHaveBeenCalledExactlyOnceWith([
    { impId: imp.id, checkpointIds: ['cp-1'] },
  ]);
});

test('it keeps each count with the time its pass started', async () => {
  const ctx = await setupTest();

  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imp = await createImp(ctx.db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  const usage = buildMockImpDiskUsage();

  // the measure takes four seconds of the clock
  const clock = { now: new Date(5000) };

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: {
      measureUsage: () => {
        clock.now = new Date(9000);

        return Promise.resolve({ imps: new Map([[imp.id, usage]]), isPartial: true });
      },
    },
    log: mock<(message: string) => void>(),
    now: () => clock.now,
  });

  onTestFinished(() => {
    cache.stop();
  });

  await cache.runPass();

  expect(cache.read(imp.id)).toStrictEqual({
    exclusiveBytes: usage.exclusiveBytes,
    sharedBytes: usage.sharedBytes,
    isUpperBound: false,
    isPartial: true,
    measuredAt: new Date(5000),
  });
});

test('it reads no count for an imp before the first pass', async () => {
  const ctx = await setupTest();

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: { measureUsage: () => Promise.resolve({ imps: new Map(), isPartial: false }) },
    log: mock<(message: string) => void>(),
  });

  onTestFinished(() => {
    cache.stop();
  });

  expect(cache.read('dev')).toBeUndefined();
});

test('it totals what every imp takes on its own', async () => {
  const ctx = await setupTest();

  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const dev = await createImp(ctx.db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  const ci = await createImp(ctx.db, {
    name: 'ci',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 1,
    ip: '10.66.0.3',
  });

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: {
      measureUsage: () =>
        Promise.resolve({
          imps: new Map([
            [dev.id, buildMockImpDiskUsage({ exclusiveBytes: 10 })],
            [ci.id, buildMockImpDiskUsage({ exclusiveBytes: 32 })],
          ]),
          isPartial: false,
        }),
    },
    log: mock<(message: string) => void>(),
  });

  onTestFinished(() => {
    cache.stop();
  });

  await cache.runPass();

  expect(cache.readExclusiveTotal()).toBe(42);
});

test('it shares a pass under way with a second caller', async () => {
  const ctx = await setupTest();

  const measured = Promise.withResolvers<DiskUsageReport>();

  onTestFinished(() => {
    measured.resolve({ imps: new Map(), isPartial: false });
  });

  const measureUsage = mock<StorageBackend['measureUsage']>(() => measured.promise);

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: { measureUsage },
    log: mock<(message: string) => void>(),
  });

  onTestFinished(() => {
    cache.stop();
  });

  const first = cache.runPass();
  const second = cache.runPass();

  measured.resolve({ imps: new Map(), isPartial: false });

  await Promise.all([first, second]);

  expect(measureUsage).toHaveBeenCalledOnce();
});

test('it keeps the last count when a pass fails', async () => {
  const ctx = await setupTest();

  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imp = await createImp(ctx.db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  const measureUsage = mock<StorageBackend['measureUsage']>(() =>
    Promise.resolve({
      imps: new Map([[imp.id, buildMockImpDiskUsage({ exclusiveBytes: 10 })]]),
      isPartial: false,
    }),
  );

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: { measureUsage },
    log: mock<(message: string) => void>(),
  });

  onTestFinished(() => {
    cache.stop();
  });

  await cache.runPass();

  measureUsage.mockImplementation(() => Promise.reject(new Error('pool gone')));

  await cache.runPass();

  expect(cache.read(imp.id)?.exclusiveBytes).toBe(10);
});

test('it logs a pass that fails', async () => {
  const ctx = await setupTest();

  const log = mock<(message: string) => void>();

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: { measureUsage: () => Promise.reject(new Error('pool gone')) },
    log,
  });

  onTestFinished(() => {
    cache.stop();
  });

  await cache.runPass();

  expect(log).toHaveBeenCalledExactlyOnceWith('impd: disk usage: pool gone');
});

test('it keeps the last count of an imp a cut-short pass did not reach', async () => {
  const ctx = await setupTest();

  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imp = await createImp(ctx.db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  const clock = { ms: 1000 };

  const measureUsage = mock<StorageBackend['measureUsage']>(() =>
    Promise.resolve({
      imps: new Map([[imp.id, buildMockImpDiskUsage({ exclusiveBytes: 10 })]]),
      isPartial: false,
    }),
  );

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: { measureUsage },
    log: mock<(message: string) => void>(),
    now: () => new Date(clock.ms),
  });

  onTestFinished(() => {
    cache.stop();
  });

  await cache.runPass();

  // the second pass reached no imp
  clock.ms = 9000;

  measureUsage.mockImplementation(() => Promise.resolve({ imps: new Map(), isPartial: true }));

  await cache.runPass();

  expect(cache.read(imp.id)).toMatchObject({
    exclusiveBytes: 10,
    isPartial: false,
    measuredAt: new Date(1000),
  });
});

test('it stamps a count with the time its pass started, not the time it ended', async () => {
  const ctx = await setupTest();

  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imp = await createImp(ctx.db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  const clock = { ms: 1000 };

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: {
      measureUsage: () => {
        // the measure is slow: a write lands while it runs
        clock.ms = 9000;

        return Promise.resolve({
          imps: new Map([[imp.id, buildMockImpDiskUsage()]]),
          isPartial: false,
        });
      },
    },
    log: mock<(message: string) => void>(),
    now: () => new Date(clock.ms),
  });

  onTestFinished(() => {
    cache.stop();
  });

  await cache.runPass();

  expect(cache.read(imp.id)?.measuredAt).toStrictEqual(new Date(1000));
});

test('it runs a refresh asked for during a pass as a pass of its own after it', async () => {
  const ctx = await setupTest();

  const firstReached = Promise.withResolvers<void>();
  const firstMeasured = Promise.withResolvers<DiskUsageReport>();
  const secondStarted = Promise.withResolvers<void>();

  onTestFinished(() => {
    firstMeasured.resolve({ imps: new Map(), isPartial: false });
  });

  const measureUsage = mock<StorageBackend['measureUsage']>(() => {
    secondStarted.resolve();

    return Promise.resolve({ imps: new Map(), isPartial: false });
  });

  measureUsage.mockImplementationOnce(() => {
    firstReached.resolve();

    return firstMeasured.promise;
  });

  const startTimer = mock<(fire: () => void, ms: number) => () => void>(() => () => {});

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: { measureUsage },
    log: mock<(message: string) => void>(),
    startTimer,
  });

  onTestFinished(() => {
    cache.stop();
  });

  const first = cache.runPass();

  await firstReached.promise;

  cache.requestRefresh();

  // the refresh's timer fires while the first pass still measures
  const fire = startTimer.mock.calls[0]?.[0];

  invariant(fire);
  fire();

  const callsDuringFirst = measureUsage.mock.calls.length;

  firstMeasured.resolve({ imps: new Map(), isPartial: false });

  await first;
  await secondStarted.promise;

  expect(callsDuringFirst).toBe(1);
  expect(measureUsage).toHaveBeenCalledTimes(2);
});

test('it starts one refresh timer for a burst of refresh requests', async () => {
  const ctx = await setupTest();

  const startTimer = mock<(fire: () => void, ms: number) => () => void>(() => () => {});

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: { measureUsage: () => Promise.resolve({ imps: new Map(), isPartial: false }) },
    log: mock<(message: string) => void>(),
    startTimer,
  });

  onTestFinished(() => {
    cache.stop();
  });

  cache.requestRefresh();
  cache.requestRefresh();
  cache.requestRefresh();

  expect(startTimer).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 10_000);
});

test('it cancels a pending refresh when it stops', async () => {
  const ctx = await setupTest();

  const cancel = mock<() => void>();

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: { measureUsage: () => Promise.resolve({ imps: new Map(), isPartial: false }) },
    log: mock<(message: string) => void>(),
    startTimer: () => cancel,
  });

  cache.requestRefresh();
  cache.stop();

  expect(cancel).toHaveBeenCalledOnce();
});

test('it starts no refresh after it stops', async () => {
  const ctx = await setupTest();

  const startTimer = mock<(fire: () => void, ms: number) => () => void>(() => () => {});

  const cache = createDiskUsageCache({
    db: ctx.db,
    storage: { measureUsage: () => Promise.resolve({ imps: new Map(), isPartial: false }) },
    log: mock<(message: string) => void>(),
    startTimer,
  });

  cache.stop();
  cache.requestRefresh();

  expect(startTimer).not.toHaveBeenCalled();
});
