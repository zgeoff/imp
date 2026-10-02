import { expect, test } from 'bun:test';
import { statSync, truncateSync } from 'node:fs';
import { findImpByName } from '../db/imps';
import { runChecked } from '../process/run-command';
import { buildImpPaths } from '../storage/data-layout';
import { buildTestApp, setupImpTest } from './test-imps';

const GIB_MIB = 1024;

// a sparse copy: grown disks stay holes on the test's tmpfs
async function createSparseClone(source: string, target: string): Promise<void> {
  await runChecked(['cp', '--sparse=always', source, target]);
}

async function setupDiskTest() {
  const harness = await setupImpTest({ cloneDisk: createSparseClone });

  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);

  const findDisk = async (name: string) => {
    const imp = await findImpByName(harness.db, name);

    return buildImpPaths(harness.dataDir, imp?.id ?? '').disk;
  };

  const readDisk = async (name: string) => {
    const imp = await findImpByName(harness.db, name);

    const disk = buildImpPaths(harness.dataDir, imp?.id ?? '').disk;

    return { fileBytes: statSync(disk).size, isGrowPending: imp?.isDiskGrowPending };
  };

  return { ...harness, client: app.client, findDisk, readDisk };
}

test('a new disk takes the size asked for, and never less than its image', async () => {
  await using ctx = await setupDiskTest();

  const sized = await ctx.client.imps.create({ name: 'sized', diskMib: 2 * GIB_MIB });

  expect(sized.diskMib).toBe(2 * GIB_MIB);

  const disk1 = await ctx.readDisk('sized');

  expect(disk1).toEqual({ fileBytes: 2 * 1024 ** 3, isGrowPending: false });

  // the host grew the filesystem before the first boot
  const sizedDisk = await ctx.findDisk('sized');

  expect(ctx.filesystemGrows).toEqual([sizedDisk]);

  // an image whose filesystem is 3 GiB
  await ctx.createTestImage('big');

  truncateSync(`${ctx.dataDir}/images/big/rootfs.ext4`, 3 * 1024 ** 3);

  const small = await ctx.client.imps
    .create({ name: 'small', image: 'big', diskMib: 2 * GIB_MIB })
    .catch((error: unknown) => error);

  expect(String(small)).toContain("image's filesystem (3072 MiB)");

  const fitted = await ctx.client.imps.create({ name: 'fitted', image: 'big' });

  expect(fitted.diskMib).toBe(3 * GIB_MIB);
  expect(ctx.filesystemGrows).toEqual([sizedDisk]);
});

test('a resize grows a stopped disk for its next boot, and never shrinks one', async () => {
  await using ctx = await setupDiskTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2 * GIB_MIB });
  await ctx.client.imps.stop({ name: 'dev' });

  const grown = await ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 4 * GIB_MIB });
  const devDisk = await ctx.findDisk('dev');

  // the host grows a stopped disk's filesystem: on create, then on the resize
  expect(ctx.filesystemGrows).toEqual([devDisk, devDisk]);
  expect(grown.diskMib).toBe(4 * GIB_MIB);

  const disk2 = await ctx.readDisk('dev');

  expect(disk2).toEqual({ fileBytes: 4 * 1024 ** 3, isGrowPending: false });
  expect(ctx.fake.grows).toHaveLength(0);

  const shrink = await ctx.client.imps
    .resizeDisk({ name: 'dev', diskMib: 3 * GIB_MIB })
    .catch((error: unknown) => error);

  expect(String(shrink)).toContain('a disk only grows');
});

test('a running guest grows at once; a failed grow is retried at the next wake', async () => {
  await using ctx = await setupDiskTest();

  const imp = await ctx.client.imps.create({ name: 'dev', diskMib: 2 * GIB_MIB });

  const disk = buildImpPaths(ctx.dataDir, imp.id).disk;

  await ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 3 * GIB_MIB });

  expect(ctx.fake.grows).toEqual([{ disk, diskBytes: 3 * 1024 ** 3 }]);

  // a VM has the disk open: only the create's grow ran on the host
  expect(ctx.filesystemGrows).toEqual([disk]);

  ctx.fake.queue('grow', 'fail');

  const failed = await ctx.client.imps
    .resizeDisk({ name: 'dev', diskMib: 4 * GIB_MIB })
    .catch((error: unknown) => error);

  expect(String(failed)).toContain('its next wake or boot does');

  const disk3 = await ctx.readDisk('dev');

  expect(disk3).toEqual({ fileBytes: 4 * 1024 ** 3, isGrowPending: true });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  expect(ctx.fake.grows.at(-1)).toEqual({ disk, diskBytes: 4 * 1024 ** 3 });

  const disk6 = await ctx.readDisk('dev');

  expect(disk6.isGrowPending).toBeFalse();
});

test('a sleeping guest grows when it wakes, and a cold boot needs no grow call', async () => {
  await using ctx = await setupDiskTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2 * GIB_MIB });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 3 * GIB_MIB });

  const disk4 = await ctx.readDisk('dev');

  expect(disk4).toEqual({ fileBytes: 3 * 1024 ** 3, isGrowPending: true });
  expect(ctx.fake.grows).toHaveLength(0);

  await ctx.client.imps.wake({ name: 'dev' });

  expect(ctx.fake.grows.map((grow) => grow.diskBytes)).toEqual([3 * 1024 ** 3]);

  const disk7 = await ctx.readDisk('dev');

  expect(disk7.isGrowPending).toBeFalse();

  // stage 1 grows a cold boot's filesystem: a pending grow clears
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 4 * GIB_MIB });
  await ctx.client.imps.stop({ name: 'dev' });
  await ctx.client.imps.start({ name: 'dev' });

  expect(ctx.fake.grows).toHaveLength(1);

  const disk8 = await ctx.readDisk('dev');

  expect(disk8.isGrowPending).toBeFalse();
});

test('a checkpoint keeps its disk size, and a restore or a fork takes it', async () => {
  await using ctx = await setupDiskTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2 * GIB_MIB });

  const checkpoint = await ctx.client.checkpoints.create({ name: 'dev', label: 'small' });

  expect(checkpoint.diskMib).toBe(2 * GIB_MIB);

  await ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 5 * GIB_MIB });

  const fork = await ctx.client.imps.fork({ source: 'dev', name: 'copy', checkpoint: 'small' });

  expect(fork.diskMib).toBe(2 * GIB_MIB);

  const live = await ctx.client.imps.fork({ source: 'dev', name: 'live' });

  expect(live.diskMib).toBe(5 * GIB_MIB);

  const restored = await ctx.client.checkpoints.restore({ name: 'dev', checkpoint: 'small' });

  expect(restored.diskMib).toBe(2 * GIB_MIB);

  const disk5 = await ctx.readDisk('dev');

  expect(disk5).toEqual({ fileBytes: 2 * 1024 ** 3, isGrowPending: false });
});

test('past the reserve, creates, resizes and wakes are refused, and a sleep keeps its VM', async () => {
  await using ctx = await setupDiskTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2 * GIB_MIB, memoryMib: 1024 });
  await ctx.client.imps.create({ name: 'idle', diskMib: 2 * GIB_MIB });
  await ctx.client.imps.sleep({ name: 'idle' });

  // 100 GiB with 6 GiB free: room for the 5 GiB reserve, not for a 1 GiB memory file too
  ctx.diskUsage.usedBytes = 94 * 1024 ** 3;
  ctx.diskUsage.availableBytes = 5.5 * 1024 ** 3;

  const sleep = await ctx.client.imps.sleep({ name: 'dev' }).catch((error: unknown) => error);

  expect(sleep).toMatchObject({ code: 'DISK_FULL' });

  const dev = await ctx.client.imps.get({ name: 'dev' });

  expect(dev.state).toBe('running');

  ctx.diskUsage.availableBytes = 4 * 1024 ** 3;

  const refusals = await Promise.all([
    ctx.client.imps.create({ name: 'more' }).catch((error: unknown) => error),
    ctx.client.imps
      .resizeDisk({ name: 'dev', diskMib: 3 * GIB_MIB })
      .catch((error: unknown) => error),
    ctx.client.imps.wake({ name: 'idle' }).catch((error: unknown) => error),
    ctx.client.checkpoints.create({ name: 'dev' }).catch((error: unknown) => error),
  ]);

  for (const refusal of refusals) {
    expect(refusal).toMatchObject({ code: 'DISK_FULL' });
  }

  const info = await ctx.client.system.info();

  expect(info.storage).toMatchObject({ reserveBytes: 5 * 1024 ** 3, isLow: true });
  expect(info.storage.impDiskBytes).toBe(4 * 1024 ** 3);
});
