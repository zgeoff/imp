import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findImpByName } from '../db/imps';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { readSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import { buildMemoryMax, createCpuCgroups } from '../vmm/cpu-cgroups';
import type { CpuCgroups } from '../vmm/cpu-cgroups';

// Elastic imps through the router, on the fake VMs: what create accepts, and
// what a sleep and a wake do with the plugged memory.
async function setupElasticTest(env: Readonly<Record<string, string>> = {}, cgroups?: CpuCgroups) {
  const harness = await setupImpTest({ env, ...(cgroups !== undefined && { cgroups }) });

  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);

  const findPaths = async (name: string) => {
    const imp = await findImpByName(harness.db, name);

    return buildImpPaths(harness.dataDir, imp?.id ?? '');
  };

  return { ...harness, client: app.client, findPaths };
}

test('a max above 4 × memory, or below it, is refused at create', async () => {
  const ctx = await setupElasticTest();

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
  const ctx = await setupElasticTest({ IMP_RAM_BUDGET_MIB: '1024' });

  // its memory fits, but the guest could grow past the budget
  const refused = await ctx.client.imps
    .create({ name: 'big', memoryMib: 512, maxMemoryMib: 2048 })
    .catch((error: unknown) => error);

  expect(refused).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
  expect(String(refused)).toContain('at its max (2048 MiB)');
});

test('a sleep unplugs what the guest can spare, and the wake allows what it kept', async () => {
  const ctx = await setupElasticTest();
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
  const ctx = await setupElasticTest();
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
  const ctx = await setupElasticTest();

  await ctx.client.imps.create({ name: 'plain', memoryMib: 256 });

  const paths = await ctx.findPaths('plain');

  await ctx.client.imps.sleep({ name: 'plain' });

  expect(ctx.fake.guestMemory.has(paths.dir)).toBe(false);
  expect(readSnapshotMeta(paths)?.pluggedMib).toBeUndefined();
});

// a cgroup root in a temp dir with the cpu and memory controllers handed to
// imps/, as setup-cgroups.sh leaves it
function setupCgroupRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-elastic-cgroups-'));

  mkdirSync(join(dir, 'imps'), { recursive: true });
  writeFileSync(join(dir, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  // the cgroup writer of the impd running now; a restart gets a new one,
  // which knows nothing of the sizes the last one set
  const current = { cgroups: createCpuCgroups({ root: dir, log: () => {} }) };

  const cgroups = new Proxy(current.cgroups, {
    get: (_target, key: keyof CpuCgroups) => current.cgroups[key],
  });

  return {
    cgroups,
    restart: () => {
      current.cgroups = createCpuCgroups({ root: dir, log: () => {} });
    },
    readMemoryMax: (impId: string) => readFileSync(join(dir, 'imps', impId, 'memory.max'), 'utf8'),
    [Symbol.dispose]: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("memory.max follows the guest: its memory at boot, raised by a grow, the plug's size at wake", async () => {
  using root = setupCgroupRoot();

  const ctx = await setupElasticTest({}, root.cgroups);

  // an agent that moves its container's limit with the guest
  ctx.fake.agent.version = '0.17.0';

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });
  const paths = await ctx.findPaths('dev');

  expect(root.readMemoryMax(created.id)).toBe(buildMemoryMax(256));

  // 56 MiB available, under the 128 MiB mark: the next tick plugs a step
  ctx.fake.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 0,
    requestedMib: 0,
    usedMib: 200,
    unplugFloorMib: 0,
  });

  await ctx.memory.runTick();

  expect(ctx.fake.guestMemory.get(paths.dir)?.pluggedMib).toBe(256);
  expect(root.readMemoryMax(created.id)).toBe(buildMemoryMax(512));

  // the guest has nothing to spare, so it sleeps with the step plugged
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  expect(readSnapshotMeta(paths)).toBeNull();
  expect(root.readMemoryMax(created.id)).toBe(buildMemoryMax(512));

  // a stop forgets the size: the next cold boot starts at the memory again
  await ctx.client.imps.stop({ name: 'dev' });
  await ctx.client.imps.start({ name: 'dev' });

  expect(root.readMemoryMax(created.id)).toBe(buildMemoryMax(256));
});

test('after a restart, adopt allows what the guest holds before a sleep can set up its cgroup', async () => {
  using root = setupCgroupRoot();

  const ctx = await setupElasticTest({}, root.cgroups);
  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });
  const paths = await ctx.findPaths('dev');

  // 512 plugged, none of it free to unplug
  ctx.fake.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 512,
    requestedMib: 512,
    usedMib: 700,
    unplugFloorMib: 512,
  });

  root.restart();

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  expect(root.readMemoryMax(created.id)).toBe(buildMemoryMax(768));

  // before any tick of the new impd's controller
  await impd.imps.sleepImp('dev');

  expect(root.readMemoryMax(created.id)).toBe(buildMemoryMax(768));
  expect(readSnapshotMeta(paths)).toMatchObject({ pluggedMib: 512 });
});

test('an elastic imp whose agent predates elastic memory is not grown, and the log says why', async () => {
  const ctx = await setupElasticTest();

  await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = await ctx.findPaths('dev');

  ctx.fake.guestMemory.set(paths.dir, {
    baseMib: 256,
    pluggedMib: 0,
    requestedMib: 0,
    usedMib: 200,
    unplugFloorMib: 0,
  });

  await ctx.memory.runTick();

  expect(ctx.fake.guestMemory.get(paths.dir)?.pluggedMib).toBe(0);

  const refusal = ctx.logs.find((line) => line.includes('dev: memory low, not grown'));

  expect(refusal).toContain("the imp's agent has no elastic memory");
});
