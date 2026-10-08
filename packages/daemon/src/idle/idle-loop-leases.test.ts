import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { findImpByName, updateImpActivity } from '../db/imps';
import { writeLease } from '../db/leases';
import { setupImpTest } from '../imps/test-imps';
import { createIdleLoop } from './idle-loop';

const IDLE_TIMEOUT_MS = 1000;

afterEach(() => {
  setSystemTime();
});

// The idle loop reads the wall clock; the test moves it past the lease's end
// rather than wait for it, so the order of the checks is fixed.
test('after the later of two leases is released, the idle loop sleeps the imp once the earlier ends', async () => {
  const ctx = await setupImpTest({
    env: { IMP_IDLE_TIMEOUT_S: String(IDLE_TIMEOUT_MS / 1000) },
  });

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const at = Date.now();
  const earlierEnd = at + 60_000;

  for (const [label, until] of [
    ['early', earlierEnd],
    ['late', at + 600_000],
  ] as const) {
    await writeLease(
      ctx.db,
      {
        impId: imp.id,
        principal: 'token:a',
        label,
        display: 'a',
        until: new Date(until),
        createdAt: new Date(at),
      },
      { at, reason: 'held' },
    );
  }

  const released = await ctx.imps.releaseLease(
    'dev',
    { principal: 'token:a', display: 'a' },
    'late',
  );

  const held = await findImpByName(ctx.db, 'dev');

  expect(released).toBeTrue();
  expect(held?.holdUntil).toEqual(new Date(earlierEnd));

  // idle long past the timeout: only the lease keeps it awake
  await updateImpActivity(ctx.db, imp.id, new Date(at - 60_000));

  const idle = createIdleLoop({ config: ctx.config, db: ctx.db, imps: ctx.imps, log: () => {} });

  await idle.runCheck();

  const whileLeased = await findImpByName(ctx.db, 'dev');

  // a lease counts as activity, so the idle timeout runs from its end
  setSystemTime(new Date(earlierEnd + IDLE_TIMEOUT_MS + 1));

  await idle.runCheck();

  const afterEnd = await findImpByName(ctx.db, 'dev');

  expect(whileLeased?.state).toBe('running');
  expect(afterEnd?.state).toBe('sleeping');
});
