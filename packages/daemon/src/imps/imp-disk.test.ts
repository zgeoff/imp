import { expect, onTestFinished, test } from 'bun:test';
import { statSync, truncateSync } from 'node:fs';
import { createImp, findImpByName } from '../db/imps';
import { runChecked } from '../process/run-command';
import { buildImpPaths } from '../storage/data-layout';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import { buildStubDiskTools } from '../test-utils/build-stub-disk-tools';
import { buildTestApp, createImpTest } from './test-imps';

// impd over the stub VMM, and a client of its API
async function setupTest(
  config: Readonly<{
    // the host's grow of a filesystem; reported grown by default
    growFilesystem?: (disk: string) => Promise<boolean>;
  }> = {},
) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, {
    // a sparse copy, so the grown disks stay holes on the test's tmpfs
    cloneDisk: async (source, target) => {
      await runChecked(['cp', '--sparse=always', source, target]);
    },
    ...(config.growFilesystem !== undefined && { growFilesystem: config.growFilesystem }),
  });

  // every create boots an image row; the default image is ubuntu
  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);

  return { ...harness, client: app.client };
}

test('it makes a new disk the size asked for', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'sized', diskMib: 2048 });
  const imp = await findImpByName(ctx.db, 'sized');

  expect(created.diskMib).toBe(2048);
  expect(statSync(buildImpPaths(ctx.dataDir, created.id).disk).size).toBe(2 * 1024 ** 3);
  expect(imp?.isDiskGrowPending).toBeFalse();
});

test('it grows the filesystem of a new disk on the host before the first boot', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'sized', diskMib: 2048 });

  expect(ctx.filesystemGrows).toStrictEqual([buildImpPaths(ctx.dataDir, created.id).disk]);
});

test('it leaves an unclean filesystem of a new disk for its boot to grow, and says so', async () => {
  const disk = buildStubDiskTools();

  disk.setUnclean(true);

  const ctx = await setupTest({ growFilesystem: disk.growFilesystem });
  const created = await ctx.client.imps.create({ name: 'sized', diskMib: 2048 });

  expect(created.state).toBe('running');
  expect(disk.grows).toStrictEqual([buildImpPaths(ctx.dataDir, created.id).disk]);

  expect(ctx.logs).toContain(
    'impd: sized: the filesystem was not unmounted cleanly; its boot grows it',
  );
});

test('it refuses a disk smaller than its image filesystem', async () => {
  const ctx = await setupTest();

  // an image whose filesystem is 3 GiB
  await ctx.createTestImage('big');

  truncateSync(`${ctx.dataDir}/images/big/rootfs.ext4`, 3 * 1024 ** 3);

  expect(
    ctx.client.imps.create({ name: 'small', image: 'big', diskMib: 2048 }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: "a disk of 2048 MiB is smaller than the image's filesystem (3072 MiB)",
  });
});

test('it sizes a disk asked for no size to its image filesystem, with no grow', async () => {
  const ctx = await setupTest();

  // an image whose filesystem is 3 GiB
  await ctx.createTestImage('big');

  truncateSync(`${ctx.dataDir}/images/big/rootfs.ext4`, 3 * 1024 ** 3);

  const fitted = await ctx.client.imps.create({ name: 'fitted', image: 'big' });

  expect(fitted.diskMib).toBe(3072);
  expect(ctx.filesystemGrows).toBeEmpty();
});

test('it grows a stopped disk and its filesystem on the host at a resize', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });

  await ctx.client.imps.stop({ name: 'dev' });

  const grown = await ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 4096 });

  const disk = buildImpPaths(ctx.dataDir, created.id).disk;

  const imp = await findImpByName(ctx.db, 'dev');

  expect(grown.diskMib).toBe(4096);
  expect(statSync(disk).size).toBe(4 * 1024 ** 3);
  expect(imp?.isDiskGrowPending).toBeFalse();

  // the host grows a stopped disk's filesystem: on create, then on the resize
  expect(ctx.filesystemGrows).toStrictEqual([disk, disk]);
  expect(ctx.fake.grows).toBeEmpty();
});

test('it refuses to shrink a disk', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 4096 });
  await ctx.client.imps.stop({ name: 'dev' });

  expect(ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 3072 })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'a disk of 3072 MiB is smaller than the disk now; a disk only grows (4096 MiB)',
  });
});

test('it refuses to resize the disk of an imp still being created', async () => {
  const ctx = await setupTest();
  const image = await ctx.createTestImage('base');

  await createImp(ctx.db, buildMockNewImp({ name: 'dev', imageId: image.id }));

  expect(ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 4096 })).rejects.toMatchObject({
    code: 'INVALID_STATE',
  });
});

test('it grows the filesystem of a running guest at once', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });

  await ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 3072 });

  const disk = buildImpPaths(ctx.dataDir, created.id).disk;

  expect(ctx.fake.grows).toStrictEqual([{ disk, diskBytes: 3 * 1024 ** 3 }]);

  // a VM has the disk open: only the create's grow ran on the host
  expect(ctx.filesystemGrows).toStrictEqual([disk]);
});

test('it marks the grow pending when a running guest fails to grow', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });

  ctx.fake.queue('grow', 'fail');

  const resizing = ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 4096 });

  expect(resizing).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  expect(resizing).rejects.toThrow(
    'the disk grew, but the guest did not grow its filesystem (its next wake or boot does)',
  );

  const imp = await findImpByName(ctx.db, 'dev');

  expect(statSync(buildImpPaths(ctx.dataDir, created.id).disk).size).toBe(4 * 1024 ** 3);
  expect(imp?.isDiskGrowPending).toBeTrue();
});

test('it retries a failed guest grow at the next wake', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });

  ctx.fake.queue('grow', 'fail');

  expect(ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 4096 })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.grows.at(-1)).toStrictEqual({
    disk: buildImpPaths(ctx.dataDir, created.id).disk,
    diskBytes: 4 * 1024 ** 3,
  });

  expect(imp?.isDiskGrowPending).toBeFalse();
});

test('it leaves the grow to the next boot for an agent from before grow', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });

  ctx.fake.queue('grow', 'die');

  expect(ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 5120 })).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
    message:
      "the disk grew, but the imp's agent is too old to grow its filesystem while it runs; its next boot does (stop and start the imp)",
  });
});

test('it marks the grow of a sleeping guest pending, with no grow call', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 3072 });

  const imp = await findImpByName(ctx.db, 'dev');

  expect(statSync(buildImpPaths(ctx.dataDir, created.id).disk).size).toBe(3 * 1024 ** 3);
  expect(imp?.isDiskGrowPending).toBeTrue();
  expect(ctx.fake.grows).toBeEmpty();
});

test('it grows a sleeping guest when it wakes', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 3072 });
  await ctx.client.imps.wake({ name: 'dev' });

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.grows.map((grow) => grow.diskBytes)).toStrictEqual([3 * 1024 ** 3]);
  expect(imp?.isDiskGrowPending).toBeFalse();
});

test('it clears a pending grow at a cold boot, with no grow call', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 3072 });
  await ctx.client.imps.stop({ name: 'dev' });

  // the agent grows a cold boot's filesystem
  await ctx.client.imps.start({ name: 'dev' });

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.grows).toBeEmpty();
  expect(imp?.isDiskGrowPending).toBeFalse();
});

test('it keeps the disk size in a checkpoint', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });

  const checkpoint = await ctx.client.checkpoints.create({ name: 'dev', label: 'small' });

  expect(checkpoint.diskMib).toBe(2048);
});

test('it gives a fork from a checkpoint the disk size of the checkpoint', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });
  await ctx.client.checkpoints.create({ name: 'dev', label: 'small' });
  await ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 5120 });

  const fork = await ctx.client.imps.fork({ source: 'dev', name: 'copy', checkpoint: 'small' });

  expect(fork.diskMib).toBe(2048);
});

test('it gives a live fork the disk size of its source now', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });
  await ctx.client.checkpoints.create({ name: 'dev', label: 'small' });
  await ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 5120 });

  const live = await ctx.client.imps.fork({ source: 'dev', name: 'live' });

  expect(live.diskMib).toBe(5120);
});

test('it gives a restored imp the disk size of the checkpoint', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });

  await ctx.client.checkpoints.create({ name: 'dev', label: 'small' });
  await ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 5120 });

  const restored = await ctx.client.checkpoints.restore({ name: 'dev', checkpoint: 'small' });
  const imp = await findImpByName(ctx.db, 'dev');

  expect(restored.diskMib).toBe(2048);
  expect(statSync(buildImpPaths(ctx.dataDir, created.id).disk).size).toBe(2 * 1024 ** 3);
  expect(imp?.isDiskGrowPending).toBeFalse();
});

test('it refuses a sleep the disk has no room for, and keeps the VM running', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2048, memoryMib: 1024 });

  // 100 GiB with 5.5 GiB free: room for the 5 GiB reserve, not for a 1 GiB memory file too
  ctx.diskUsage.usedBytes = 94.5 * 1024 ** 3;
  ctx.diskUsage.availableBytes = 5.5 * 1024 ** 3;

  expect(ctx.client.imps.sleep({ name: 'dev' })).rejects.toMatchObject({ code: 'DISK_FULL' });

  const dev = await ctx.client.imps.get({ name: 'dev' });

  expect(dev.state).toBe('running');
});

test('it refuses a create past the disk reserve', async () => {
  const ctx = await setupTest();

  // 100 GiB with 4 GiB free: inside the 5 GiB reserve
  ctx.diskUsage.usedBytes = 96 * 1024 ** 3;
  ctx.diskUsage.availableBytes = 4 * 1024 ** 3;

  expect(ctx.client.imps.create({ name: 'more' })).rejects.toMatchObject({ code: 'DISK_FULL' });
});

test('it refuses a resize past the disk reserve', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });

  // 100 GiB with 4 GiB free: inside the 5 GiB reserve
  ctx.diskUsage.usedBytes = 96 * 1024 ** 3;
  ctx.diskUsage.availableBytes = 4 * 1024 ** 3;

  expect(ctx.client.imps.resizeDisk({ name: 'dev', diskMib: 3072 })).rejects.toMatchObject({
    code: 'DISK_FULL',
  });
});

test('it refuses a checkpoint past the disk reserve', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });

  // 100 GiB with 4 GiB free: inside the 5 GiB reserve
  ctx.diskUsage.usedBytes = 96 * 1024 ** 3;
  ctx.diskUsage.availableBytes = 4 * 1024 ** 3;

  expect(ctx.client.checkpoints.create({ name: 'dev' })).rejects.toMatchObject({
    code: 'DISK_FULL',
  });
});

test('it wakes a sleeping imp past the disk reserve', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'idle', diskMib: 2048 });
  await ctx.client.imps.sleep({ name: 'idle' });

  // 100 GiB with 4 GiB free: inside the 5 GiB reserve; its disk and memory
  // exist already, so a full disk must not strand its work
  ctx.diskUsage.usedBytes = 96 * 1024 ** 3;
  ctx.diskUsage.availableBytes = 4 * 1024 ** 3;

  const woken = await ctx.client.imps.wake({ name: 'idle' });

  expect(woken.state).toBe('running');
});

test('it reports the reserve, the low disk and the imp disks in system info', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev', diskMib: 2048 });
  await ctx.client.imps.create({ name: 'idle', diskMib: 2048 });

  // 100 GiB with 4 GiB free: inside the 5 GiB reserve
  ctx.diskUsage.usedBytes = 96 * 1024 ** 3;
  ctx.diskUsage.availableBytes = 4 * 1024 ** 3;

  const info = await ctx.client.system.info();

  expect(info.storage.reserveBytes).toBe(5 * 1024 ** 3);
  expect(info.storage.isLow).toBeTrue();
  expect(info.storage.impDiskBytes).toBe(4 * 1024 ** 3);
});
