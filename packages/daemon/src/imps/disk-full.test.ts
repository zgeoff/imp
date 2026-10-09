import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { findImpByName } from '../db/imps';
import { buildImpPaths } from '../storage/data-layout';
import { buildTestApp, createImpTest } from './test-imps';
import type { ImpTestOptions } from './test-imps';

// a disk too full for what impd is asked to write

async function setupTest(options: ImpTestOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, options);

  // the image every imp boots from
  await harness.createTestImage('ubuntu');

  return { ...harness, client: buildTestApp(harness, harness).client };
}

test('it refuses a sleep the disk cannot take with DISK_FULL and leaves the imp awake', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  // the 5 GiB reserve and a 2 GiB guest: 7 GiB needed
  ctx.diskUsage.availableBytes = 6 * 1024 ** 3;

  const sleeping = ctx.client.imps.sleep({ name: 'dev' });

  expect(sleeping).rejects.toMatchObject({ code: 'DISK_FULL' });

  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp?.state).toBe('running');
  expect(existsSync(buildImpPaths(ctx.dataDir, created.id).vmstate)).toBeFalse();
});

test('it refuses an admission the disk keeps from making room with DISK_FULL', async () => {
  const ctx = await setupTest({
    env: { IMP_RAM_BUDGET_MIB: '1000', IMP_DEFAULT_MEMORY_MIB: '512' },
  });

  await ctx.imps.createImp({ name: 'a' });

  // the 5 GiB reserve and a's 512 MiB do not fit
  ctx.diskUsage.availableBytes = 5.25 * 1024 ** 3;

  const admitting = ctx.governor.admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 });

  expect(admitting).rejects.toMatchObject({
    code: 'DISK_FULL',
    data: { reserveBytes: 5 * 1024 ** 3 },
  });
});
