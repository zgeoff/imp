import { expect, test } from 'bun:test';
import { createDiskBudget } from './disk-budget';

const GIB = 1024 ** 3;

function setupBudget(availableBytes: number, reserveBytes: number | null = null) {
  const usage = { usedBytes: 100 * GIB - availableBytes, availableBytes };
  const logs: string[] = [];

  const budget = createDiskBudget({
    storage: { readUsage: () => Promise.resolve(usage) },
    reserveBytes,
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

test('a create past the reserve is refused even with an estimate of 0', async () => {
  const ctx = setupBudget(3 * GIB);

  const refused = await ctx.budget.requireRoom(0).catch((error: unknown) => error);

  expect(refused).toMatchObject({ code: 'DISK_FULL' });
  expect(ctx.logs).toEqual(['impd: warning: low on disk: 3 GiB free, the reserve is 5 GiB']);
});
