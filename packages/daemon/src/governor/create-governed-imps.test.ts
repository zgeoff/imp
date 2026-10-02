import { expect, test } from 'bun:test';
import { setupImpTest, waitForOutcome } from '../imps/test-imps';

test('the governor skips a victim whose lock another boot holds instead of waiting for it', async () => {
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
    waitForOutcome(admitting, 2000),
    waitForOutcome(restoring, 2000),
  ]);

  expect(outcomes).not.toContain('hung');
  expect(outcomes[0]).toBe('done');
});
