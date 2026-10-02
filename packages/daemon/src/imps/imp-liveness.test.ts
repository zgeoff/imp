import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import { setupImpTest } from './test-imps';

test('a VM that died after its sleep wrote the snapshot is asleep, not stopped', async () => {
  await using ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  // impd stopped between the snapshot and the record update
  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(paths.vmstate, 'vmstate');
  writeFileSync(paths.memFile, 'mem');

  writeSnapshotMeta(paths, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: 'test',
    guestKernel: 'k',
    systemDrive: 's',
    createdAt: Date.now() + 1000,
    memoryMib: 2048,
    ramMib: 300,
  });

  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');
  const woken = await ctx.imps.wakeImp('dev');

  expect(found.state).toBe('sleeping');
  expect(woken.state).toBe('running');
  expect(ctx.fake.wakes).toHaveLength(1);
});

test('a dead VM with a snapshot from an earlier sleep is stopped', async () => {
  await using ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.sleepImp('dev');
  await Bun.sleep(5);
  await ctx.imps.wakeImp('dev');

  ctx.fake.alive.clear();

  const found = await ctx.imps.getImp('dev');

  expect(found.state).toBe('stopped');
});
