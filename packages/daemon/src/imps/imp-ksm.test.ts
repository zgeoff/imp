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
  const mergeable = options.mergeable === undefined ? true : options.mergeable;

  const harness = await setupImpTest({
    env: { ...options.env },
    readUnsharedRamMib: () => 400,
    checkGuestMerge: () => Promise.resolve(mergeable),

    // what KSM saves in each VM; the host's figure counts other processes too
    readKsmProfitMib: () => Promise.resolve(60),
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
  };
}

test('without IMP_KSM, imp info reports no KSM', async () => {
  const ctx = await setupKsmTest();

  await ctx.client.imps.create({ name: 'dev' });

  const info = await ctx.client.system.info();

  expect(info.ksm).toBeNull();
});

test('with IMP_KSM, a sleep records the unshared size for the wake reserve', async () => {
  const ctx = await setupKsmTest({ env: { IMP_KSM: '1' } });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const ramMib = await ctx.readMetaRamMib('dev');

  expect(ramMib).toBe(400);
});

test('without IMP_KSM, a sleep records the Pss as before', async () => {
  const ctx = await setupKsmTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const ramMib = await ctx.readMetaRamMib('dev');

  expect(ramMib).toBe(300);
});

test('imp info shows the saving, the headroom and the imps KSM cannot merge', async () => {
  const ctx = await setupKsmTest({
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
    headroomMib: 30,
    unmergeable: 1,
  });

  expect(ctx.harness.logs.some((line) => line.includes('KSM cannot merge'))).toBe(true);
});

test('a merge flag impd cannot read is logged, not counted as lost', async () => {
  const ctx = await setupKsmTest({ env: { IMP_KSM: '1' }, mergeable: null });

  await ctx.client.imps.create({ name: 'dev' });

  const info = await ctx.client.system.info();

  expect(info.ksm?.unmergeable).toBe(0);
  expect(ctx.harness.logs.some((line) => line.includes('cannot read whether KSM'))).toBe(true);
});

// a log line about a VM that kept the merge flag with IMP_KSM off
function isStale(line: string): boolean {
  return line.includes('keeps the KSM merge flag');
}

test('without IMP_KSM, an adopted VM that keeps the merge flag is logged once', async () => {
  const ctx = await setupKsmTest({ mergeable: true });

  await ctx.client.imps.create({ name: 'dev' });

  expect(ctx.harness.logs.filter(isStale)).toEqual([]);

  // an impd with IMP_KSM started the VM; this one adopts it
  await ctx.harness.restartImpd().imps.reconcileImps();

  expect(ctx.harness.logs.filter(isStale)).toEqual([
    'impd: dev: its VM keeps the KSM merge flag with IMP_KSM off, until the imp restarts',
  ]);
});
