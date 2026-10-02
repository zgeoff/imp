import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { findImpByName } from '../db/imps';
import { readRejection } from '../read-rejection';
import { buildImpPaths } from '../storage/data-layout';
import { buildTestApp, setupImpTest } from './test-imps';

// a disk too full for what impd is asked to write

async function setupDiskTest() {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');

  const findPaths = async (name: string) => {
    const imp = await findImpByName(ctx.db, name);

    return buildImpPaths(ctx.dataDir, imp?.id ?? '');
  };

  return { ...ctx, client: buildTestApp(ctx, ctx).client, findPaths };
}

test('a sleep the disk cannot take leaves the imp awake and says DISK_FULL', async () => {
  await using ctx = await setupDiskTest();

  await ctx.client.imps.create({ name: 'dev' });

  // the 5 GiB reserve and a 2 GiB guest: 7 GiB needed
  ctx.diskUsage.availableBytes = 6 * 1024 ** 3;

  const rejection = await readRejection(ctx.client.imps.sleep({ name: 'dev' }));
  const imp = await findImpByName(ctx.db, 'dev');
  const paths = await ctx.findPaths('dev');

  expect(rejection).toMatchObject({ code: 'DISK_FULL' });
  expect(imp?.state).toBe('running');
  expect(existsSync(paths.vmstate)).toBeFalse();
});

test('an admission the disk keeps from making room says DISK_FULL', async () => {
  await using ctx = await setupImpTest({
    env: { IMP_RAM_BUDGET_MIB: '1000', IMP_DEFAULT_MEMORY_MIB: '512' },
  });

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'a' });

  // the 5 GiB reserve and a's 512 MiB do not fit
  ctx.diskUsage.availableBytes = 5.25 * 1024 ** 3;

  const rejection = await readRejection(
    ctx.governor.admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 }),
  );

  expect(rejection).toMatchObject({ code: 'DISK_FULL', data: { reserveBytes: 5 * 1024 ** 3 } });
});
