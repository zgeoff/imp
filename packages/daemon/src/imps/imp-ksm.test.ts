import { expect, test } from 'bun:test';
import { readSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import type { KsmHostStats } from '../vmm/ksm';
import { buildTestApp, setupImpTest } from './test-imps';

const HOST_STATS: KsmHostStats = { running: true, sharedMib: 120, profitMib: 100, zeroMib: 4 };

interface KsmTestOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly mergeable?: boolean | null;
}

// impd with fake VMs whose unshared size is 400 MiB and whose Pss is 300
async function setupKsmTest(options: KsmTestOptions = {}) {
  const harness = await setupImpTest({
    env: { ...options.env },
    readUnsharedRamMib: () => 400,
    checkGuestMerge: () => options.mergeable ?? true,
    readKsmHostStats: () => HOST_STATS,
  });

  await harness.createTestImage('base');

  const client = buildTestApp(harness, harness).client;

  const readMetaRamMib = async (name: string): Promise<number | undefined> => {
    const imp = await harness.db
      .selectFrom('imps')
      .select('id')
      .where('name', '=', name)
      .executeTakeFirstOrThrow();

    return readSnapshotMeta(buildImpPaths(harness.config.dataDir, imp.id))?.ramMib;
  };

  return {
    harness,
    client,
    readMetaRamMib,
    [Symbol.asyncDispose]: () => harness[Symbol.asyncDispose](),
  };
}

test('without IMP_KSM, imp info reports no KSM', async () => {
  await using ctx = await setupKsmTest();

  await ctx.client.imps.create({ name: 'dev' });

  const info = await ctx.client.system.info();

  expect(info.ksm).toBeNull();
});

test('with IMP_KSM, a sleep records the unshared size for the wake reserve', async () => {
  await using ctx = await setupKsmTest({ env: { IMP_KSM: '1' } });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const ramMib = await ctx.readMetaRamMib('dev');

  expect(ramMib).toBe(400);
});

test('without IMP_KSM, a sleep records the Pss as before', async () => {
  await using ctx = await setupKsmTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const ramMib = await ctx.readMetaRamMib('dev');

  expect(ramMib).toBe(300);
});

test('imp info shows the saving, the headroom and the imps KSM cannot merge', async () => {
  await using ctx = await setupKsmTest({
    env: { IMP_KSM: '1', IMP_KSM_HEADROOM_PERCENT: '50' },
    mergeable: false,
  });

  await ctx.client.imps.create({ name: 'dev' });

  const info = await ctx.client.system.info();

  expect(info.ksm).toEqual({
    running: true,
    sharedMib: 120,
    profitMib: 100,
    zeroMib: 4,
    headroomMib: 50,
    unmergeable: 1,
  });

  expect(ctx.harness.logs.some((line) => line.includes('KSM cannot merge'))).toBe(true);
});
