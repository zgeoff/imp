import { expect, test } from 'bun:test';
import { createDiskBudget } from './disk-budget';

const GIB = 1024 ** 3;

function setupBudget(
  availableBytes: number,
  reserveBytes: number | null = null,
  releaseDelayMs = 0,
) {
  const usage = { usedBytes: 100 * GIB - availableBytes, availableBytes };
  const logs: string[] = [];

  const budget = createDiskBudget({
    storage: { readUsage: () => Promise.resolve(usage) },
    reserveBytes,
    releaseDelayMs,
    log: (message) => {
      logs.push(message);
    },
  });

  return { budget, usage, logs };
}

test('a write that would leave less than the reserve is refused', async () => {
  // 100 GiB: the default reserve is 5 GiB
  const ctx = setupBudget(8 * GIB);

  await ctx.budget.requireRoom(2 * GIB);

  const refused = await ctx.budget.requireRoom(4 * GIB).catch((error: unknown) => error);

  expect(refused).toMatchObject({
    code: 'DISK_FULL',
    data: { availableBytes: 8 * GIB, reserveBytes: 5 * GIB, requestedBytes: 4 * GIB },
  });
});

test('writes under way hold their room until they end', async () => {
  const ctx = setupBudget(10 * GIB, 4 * GIB);
  const release = Promise.withResolvers<void>();

  // a sleep writes 4 GiB of memory; free space shows none of it yet
  const sleeping = ctx.budget.withRoom(4 * GIB, () => release.promise);

  await Bun.sleep(1);

  const second = await ctx.budget.requireRoom(4 * GIB).catch((error: unknown) => error);

  expect(second).toMatchObject({ code: 'DISK_FULL' });

  const status = await ctx.budget.readStatus();

  expect(status).toMatchObject({ pendingBytes: 4 * GIB, reserveBytes: 4 * GIB, isLow: true });

  release.resolve();

  await sleeping;

  const after = await ctx.budget.readStatus();

  expect(after.pendingBytes).toBe(0);
});

test('a growing write holds what it has grown to, refuses past the reserve, and frees all at its end', async () => {
  const ctx = setupBudget(10 * GIB, 4 * GIB);
  const steps: unknown[] = [];

  const ended = await ctx.budget
    .withGrowingRoom(async (grow) => {
      await grow(GIB);
      await grow(GIB / 2);

      const status = await ctx.budget.readStatus();

      steps.push(status.pendingBytes);

      await grow(5 * GIB);

      const grown = await ctx.budget.readStatus();

      steps.push(grown.pendingBytes);

      await grow(7 * GIB);
    })
    .catch((error: unknown) => error);

  expect(steps).toEqual([GIB, 5 * GIB]);
  expect(ended).toMatchObject({ code: 'DISK_FULL', data: { requestedBytes: 2 * GIB } });

  const after = await ctx.budget.readStatus();

  expect(after.pendingBytes).toBe(0);
});

test('a create past the reserve is refused even with an estimate of 0', async () => {
  const ctx = setupBudget(3 * GIB);

  const refused = await ctx.budget.requireRoom(0).catch((error: unknown) => error);

  expect(refused).toMatchObject({ code: 'DISK_FULL' });
  expect(ctx.logs).toEqual(['impd: warning: low on disk: 3 GiB free, the reserve is 5 GiB']);
});

test('a hold outlives its write by the release delay, for ZFS to count it', async () => {
  const ctx = setupBudget(10 * GIB, 4 * GIB, 30);

  await ctx.budget.withRoom(2 * GIB, () => Promise.resolve());

  const soon = await ctx.budget.readStatus();

  expect(soon.pendingBytes).toBe(2 * GIB);

  await Bun.sleep(60);

  const later = await ctx.budget.readStatus();

  expect(later.pendingBytes).toBe(0);
});

test('low disk is logged once per episode, not on each refusal', async () => {
  const ctx = setupBudget(6 * GIB, 4 * GIB);

  await ctx.budget.requireRoom(4 * GIB).catch(() => null);
  await ctx.budget.requireRoom(4 * GIB).catch(() => null);
  await ctx.budget.readStatus();

  ctx.usage.availableBytes = 20 * GIB;

  await ctx.budget.readStatus();
  await ctx.budget.readStatus();

  expect(ctx.logs).toEqual([
    'impd: warning: low on disk: 6 GiB free, the reserve is 4 GiB',
    'impd: disk space is back above twice the reserve',
  ]);
});

test('free space that hovers at twice the reserve logs no more', async () => {
  const ctx = setupBudget(7 * GIB, 4 * GIB);

  await ctx.budget.readStatus();

  ctx.usage.availableBytes = 8.5 * GIB;

  await ctx.budget.readStatus();

  ctx.usage.availableBytes = 7.5 * GIB;

  await ctx.budget.readStatus();

  expect(ctx.logs).toHaveLength(1);
});
