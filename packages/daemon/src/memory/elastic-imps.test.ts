import { expect, test } from 'bun:test';
import { findImpByName } from '../db/imps';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { readSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';

// Elastic imps through the router, on the fake VMs: what create accepts, and
// what a sleep and a wake do with the plugged memory.
async function setupElasticTest(env: Readonly<Record<string, string>> = {}) {
  const harness = await setupImpTest({ env });

  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);

  const findPaths = async (name: string) => {
    const imp = await findImpByName(harness.db, name);

    return buildImpPaths(harness.dataDir, imp?.id ?? '');
  };

  return { ...harness, client: app.client, findPaths };
}

test('a max above 4 × memory, or below it, is refused at create', async () => {
  await using ctx = await setupElasticTest();

  const tooBig = await ctx.client.imps
    .create({ name: 'big', memoryMib: 256, maxMemoryMib: 1025 })
    .catch((error: unknown) => error);

  const tooSmall = await ctx.client.imps
    .create({ name: 'small', memoryMib: 512, maxMemoryMib: 256 })
    .catch((error: unknown) => error);

  expect(tooBig).toMatchObject({ code: 'BAD_REQUEST' });
  expect(String(tooBig)).toContain('more than 4 × the memory (1024 MiB)');
  expect(tooSmall).toMatchObject({ code: 'BAD_REQUEST' });

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });
  const plain = await ctx.client.imps.create({ name: 'plain', memoryMib: 256 });

  expect(created).toMatchObject({ memoryMib: 256, maxMemoryMib: 1024 });
  expect(plain.maxMemoryMib).toBeUndefined();

  // a fork grows as its source does
  const fork = await ctx.client.imps.fork({ source: 'dev', name: 'twin' });

  expect(fork).toMatchObject({ memoryMib: 256, maxMemoryMib: 1024 });
});

test('an imp whose max is larger than the whole RAM budget never boots', async () => {
  await using ctx = await setupElasticTest({ IMP_RAM_BUDGET_MIB: '1024' });

  // its memory fits, but the guest could grow past the budget
  const refused = await ctx.client.imps
    .create({ name: 'big', memoryMib: 512, maxMemoryMib: 2048 })
    .catch((error: unknown) => error);

  expect(refused).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
  expect(String(refused)).toContain('at its max (2048 MiB)');
});

test('a sleep unplugs what the guest can spare, and the wake allows what it kept', async () => {
  await using ctx = await setupElasticTest();

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });
  const paths = await ctx.findPaths('dev');

  // 512 plugged, 100 used: the target is 228, but the guest stops at 256
  ctx.fake.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 512,
    requestedMib: 512,
    usedMib: 100,
    unplugFloorMib: 256,
  });

  await ctx.client.imps.sleep({ name: 'dev' });

  expect(readSnapshotMeta(paths)).toMatchObject({ memoryMib: 256, pluggedMib: 256 });
  expect(ctx.fake.guestMemory.get(paths.dir)?.requestedMib).toBe(256);
  expect(ctx.logs.some((line) => line.includes('256 MiB plugged'))).toBe(true);

  await ctx.client.imps.wake({ name: 'dev' });

  // the boot's limit, then the wake's, before the load
  expect(ctx.memoryLimits.filter((limit) => limit.impId === created.id)).toEqual([
    { impId: created.id, guestMib: 256 },
    { impId: created.id, guestMib: 512 },
  ]);
});

test('a sleep during a plug records what the plug asked for, so the wake allows it', async () => {
  await using ctx = await setupElasticTest();

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });
  const paths = await ctx.findPaths('dev');

  // 256 plugged of 512 asked, and nothing to spare
  ctx.fake.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 256,
    requestedMib: 512,
    usedMib: 400,
    unplugFloorMib: 0,
  });

  await ctx.client.imps.sleep({ name: 'dev' });

  expect(readSnapshotMeta(paths)).toMatchObject({ pluggedMib: 512 });

  await ctx.client.imps.wake({ name: 'dev' });

  expect(ctx.memoryLimits.findLast((limit) => limit.impId === created.id)).toEqual({
    impId: created.id,
    guestMib: 768,
  });
});

test('an imp that does not grow sleeps without asking its guest', async () => {
  await using ctx = await setupElasticTest();

  await ctx.client.imps.create({ name: 'plain', memoryMib: 256 });

  const paths = await ctx.findPaths('plain');

  await ctx.client.imps.sleep({ name: 'plain' });

  expect(ctx.fake.guestMemory.has(paths.dir)).toBe(false);
  expect(readSnapshotMeta(paths)?.pluggedMib).toBeUndefined();
});
