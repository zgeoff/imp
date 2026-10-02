import { expect, test } from 'bun:test';
import { listImps } from '../db/imps';
import { setupImpTest, waitForOutcome } from '../imps/test-imps';
import type { ImpTest } from '../imps/test-imps';
import { readRejection } from '../read-rejection';

// these tests wait up to 10 s for held calls to settle; a loaded host is slow
const SLOW_TEST_TIMEOUT_MS = 30_000;

test(
  'the governor skips a victim whose lock another boot holds instead of waiting for it',
  async () => {
    // two awake imps of 300 MiB; making room for 600 MiB needs both asleep
    await using ctx = await setupImpTest({
      env: { IMP_RAM_BUDGET_MIB: '800', IMP_DEFAULT_MEMORY_MIB: '512' },
    });

    await ctx.createTestImage('ubuntu');
    await ctx.imps.createImp({ name: 'a' });
    await Bun.sleep(5);
    await ctx.imps.createImp({ name: 'b' });

    const gate = ctx.fake.hold('sleep');

    // the governor holds admission while it sleeps `a`
    const admitting = ctx.governor.admit({ id: 'x', name: 'x', reserveMib: 600, memoryMib: 600 });

    await gate.reached;

    // a restore of `b`: it takes b's lock, halts it and boots it, which asks
    // the governor for admission
    const restoring = ctx.imps.lockImp('b', async (imp) => {
      const halted = await ctx.imps.haltImp(imp);

      return ctx.imps.bootImp(halted);
    });

    await Bun.sleep(5);

    gate.release();

    const outcomes = await Promise.all([
      waitForOutcome(admitting, 10_000),
      waitForOutcome(restoring, 10_000),
    ]);

    expect(outcomes).not.toContain('hung');
    expect(outcomes[0]).toBe('done');
  },
  SLOW_TEST_TIMEOUT_MS,
);

// awake imps of 300 MiB each, in order from the least recently active
async function createAwakeImps(
  ctx: Readonly<Pick<ImpTest, 'createTestImage' | 'imps'>>,
  names: readonly string[],
): Promise<void> {
  await ctx.createTestImage('ubuntu');

  for (const name of names) {
    await ctx.imps.createImp({ name });
    await Bun.sleep(5);
  }
}

async function readStates(ctx: Readonly<Pick<ImpTest, 'db'>>): Promise<Record<string, string>> {
  const imps = await listImps(ctx.db);

  return Object.fromEntries(imps.map((imp) => [imp.name, imp.state]));
}

test('a rejected admit stops sleeping imps once a sleep fails', async () => {
  // 900 MiB awake + 900 reserved: 800 missing, so the pick is a, b and c
  await using ctx = await setupImpTest({
    env: { IMP_RAM_BUDGET_MIB: '1000', IMP_DEFAULT_MEMORY_MIB: '512' },
  });

  await createAwakeImps(ctx, ['a', 'b', 'c']);

  ctx.fake.queue('sleep', 'ok', 'fail');

  const rejection = await readRejection(
    ctx.governor.admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 }),
  );

  expect(rejection).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  // 500 MiB still missing and only c left: c is not slept for nothing
  const states = await readStates(ctx);

  expect(states).toEqual({ a: 'sleeping', b: 'running', c: 'running' });
  expect(ctx.fake.alive.size).toBe(2);
});

test('a rejected admit stops sleeping imps once the lock of a victim is taken', async () => {
  await using ctx = await setupImpTest({
    env: { IMP_RAM_BUDGET_MIB: '1000', IMP_DEFAULT_MEMORY_MIB: '512' },
  });

  await createAwakeImps(ctx, ['a', 'b', 'c']);

  // b's lock is taken while a sleeps, after the pick of a, b and c, and stays
  // taken until the admit is done
  const sleeping = ctx.fake.hold('sleep');

  const admitting = readRejection(
    ctx.governor.admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 }),
  );

  await sleeping.reached;

  const locked = Promise.withResolvers<void>();
  const unlock = Promise.withResolvers<void>();

  const locking = ctx.imps.lockImp('b', () => {
    locked.resolve();

    return unlock.promise;
  });

  await locked.promise;

  sleeping.release();

  const rejection = await admitting;

  unlock.resolve();

  await locking;

  expect(rejection).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  const states = await readStates(ctx);

  expect(states).toEqual({ a: 'sleeping', b: 'running', c: 'running' });
  expect(ctx.fake.alive.size).toBe(2);
});

test('an admit picks again past a failed sleep and fits when the rest is enough', async () => {
  // 1200 MiB awake + 900 reserved: 800 missing; without b, c and d cover it
  await using ctx = await setupImpTest({
    env: { IMP_RAM_BUDGET_MIB: '1300', IMP_DEFAULT_MEMORY_MIB: '512' },
  });

  await createAwakeImps(ctx, ['a', 'b', 'c', 'd']);

  ctx.fake.queue('sleep', 'ok', 'fail');

  await ctx.governor.admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 });

  const states = await readStates(ctx);

  expect(states).toEqual({
    a: 'sleeping',
    b: 'running',
    c: 'sleeping',
    d: 'sleeping',
  });
});
