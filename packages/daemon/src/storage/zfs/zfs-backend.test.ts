import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveStorage } from '../storage-backend';
import { FakeZfsCrashError, createFakeZfs } from './fake-zfs';
import { createZfsBackend } from './zfs-backend';

const ROOT = 'tank/imp';
const DIGEST = 'sha256:9f2c';
const IMAGE = `${ROOT}/images/9f2c`;
const VERSION = '2.2.2-0ubuntu9';

function setupTest(kernel = VERSION) {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-zfs-test-`);
  const fake = createFakeZfs({ root: ROOT, rootDir: dataDir, kernel });

  const live = {
    impIds: new Set<string>(),
    checkpointIds: new Set<string>(),
    imageDigests: new Set([DIGEST]),
  };

  // a new impd on the same pool and data dir, as after a crash or restart
  const startBackend = () =>
    createZfsBackend({
      dataDir,
      root: ROOT,
      run: fake.run,
      readMounts: fake.readMounts,
      readModuleVersion: () => kernel,
      log: () => {},
    });

  const state = { backend: startBackend() };

  return {
    dataDir,
    fake,
    live,
    get backend() {
      return state.backend;
    },
    restartImpd: async (dropMounts: boolean, liveNow: LiveStorage = live) => {
      fake.restart(dropMounts);

      state.backend = startBackend();

      await state.backend.start(liveNow);
    },
    createImp: async (impId: string) => {
      live.impIds.add(impId);

      await state.backend.createImpDisk(impId, { kind: 'image', digest: DIGEST });
    },
    createCheckpoint: (impId: string, checkpointId: string) => {
      live.checkpointIds.add(checkpointId);

      return state.backend.createCheckpoint(impId, checkpointId);
    },
    listRetired: () => fake.listDatasets().filter((name) => name.startsWith(`${ROOT}/retired/`)),
    diskDir: (impId: string) => join(dataDir, 'imps', impId, 'disk'),
    [Symbol.dispose]: () => {
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// a started backend with the image in place
async function setupStarted() {
  const ctx = setupTest();

  await ctx.backend.start(ctx.live);
  await ctx.backend.createImage(DIGEST, () => Promise.resolve());

  return ctx;
}

async function readFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('expected a failure');
}

test('start refuses a userland and kernel module of different major.minor', async () => {
  using ctx = setupTest('2.3.1-1');

  const failure = await readFailure(ctx.backend.start(ctx.live));

  expect(String(failure)).toContain(
    'the userland is 2.2.2-0ubuntu9 but the kernel module is 2.3.1-1',
  );
});

test('start refuses a data dir that is not the root dataset', async () => {
  using ctx = setupTest();

  const backend = createZfsBackend({
    dataDir: ctx.dataDir,
    root: 'tank/other',
    run: ctx.fake.run,
    readMounts: ctx.fake.readMounts,
    readModuleVersion: () => '2.2.2',
  });

  const failure = await readFailure(backend.start(ctx.live));

  expect(String(failure)).toContain(`tank/other is not mounted on ${ctx.dataDir}`);
});

test('start makes the datasets it needs, once, and mounts the memory dataset', async () => {
  using ctx = setupTest();

  await ctx.backend.start(ctx.live);

  expect(ctx.fake.commands.filter((command) => command.startsWith('zfs create'))).toEqual([
    `zfs create ${ROOT}/mem`,
    `zfs create -o recordsize=16K ${ROOT}/disks`,
    `zfs create -o recordsize=16K ${ROOT}/images`,
    `zfs create -o recordsize=16K ${ROOT}/staging`,
    `zfs create ${ROOT}/retired`,
    `zfs create -o refreservation=1G ${ROOT}/reserve`,
  ]);

  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'mem'))).toBe(`${ROOT}/mem`);

  ctx.fake.commands.length = 0;

  await ctx.restartImpd(true);

  expect(ctx.fake.commands.filter((command) => command.startsWith('zfs create'))).toEqual([]);
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'mem'))).toBe(`${ROOT}/mem`);
});

test('an image is built in staging, then renamed, snapshotted and mounted', async () => {
  using ctx = setupTest();

  await ctx.backend.start(ctx.live);

  ctx.fake.commands.length = 0;

  const dirs: string[] = [];

  await ctx.backend.createImage(DIGEST, (dir) => {
    dirs.push(dir);

    expect(ctx.fake.readMountedAt(dir)).toMatch(/^tank\/imp\/staging\/image-/);

    return Promise.resolve();
  });

  const changes = ctx.fake.commands.filter((command) => !command.startsWith('zfs list'));
  const staged = changes[0]?.split(' ')[2] ?? '';

  expect(changes).toEqual([
    `zfs create ${staged}`,
    `mount -t zfs ${staged} ${dirs[0] ?? ''}`,
    `umount ${dirs[0] ?? ''}`,
    `zfs rename ${staged} ${IMAGE}`,
    `zfs snapshot ${IMAGE}@base`,
    `mount -t zfs ${IMAGE} ${join(ctx.dataDir, 'images', '9f2c')}`,
  ]);
});

test('a failed image build leaves no dataset behind', async () => {
  using ctx = setupTest();

  await ctx.backend.start(ctx.live);

  const failure = await readFailure(
    ctx.backend.createImage(DIGEST, () => Promise.reject(new Error('mkfs failed'))),
  );

  expect(String(failure)).toContain('mkfs failed');
  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toEqual([]);
});

test('an imp disk is a mounted clone of the image, with its own paths', async () => {
  using ctx = await setupStarted();

  await ctx.createImp('a');

  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)).toBe(`${IMAGE}@base`);
  expect(ctx.fake.readMountedAt(ctx.diskDir('a'))).toBe(`${ROOT}/disks/a`);

  const paths = ctx.backend.resolveImpPaths('a');

  expect(paths.disk).toBe(join(ctx.diskDir('a'), 'rootfs.ext4'));
  expect(paths.memFile).toBe(join(ctx.dataDir, 'mem', 'a', 'mem'));
  expect(paths.vmIdentity).toBe(join(ctx.dataDir, 'imps', 'a', 'vm.json'));
});

test('a checkpoint is a snapshot sized by what was written, and its id must be new', async () => {
  using ctx = await setupStarted();

  await ctx.createImp('a');

  const sizeBytes = await ctx.createCheckpoint('a', 'cp-one');

  expect(sizeBytes).toBe(65_536);
  expect(ctx.fake.commands).toContain(`zfs snapshot ${ROOT}/disks/a@cp-one`);

  await ctx.createImp('b');

  const failure = await readFailure(ctx.backend.createCheckpoint('b', 'cp-one'));

  expect(String(failure)).toContain('a snapshot named cp-one exists already');
});

test('a restore keeps every other checkpoint, older and newer', async () => {
  using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-old');
  await ctx.createCheckpoint('a', 'cp-new');

  const order: string[] = [];

  const halted = await ctx.backend.restoreCheckpoint('a', 'cp-old', () => {
    order.push(ctx.fake.commands.at(-1) ?? '');

    return Promise.resolve('halted');
  });

  expect(halted).toBe('halted');
  expect(order).toEqual([`zfs clone ${ROOT}/disks/a@cp-old ${ROOT}/staging/restore-a`]);

  const [retired] = ctx.listRetired();

  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)).toBe(`${retired ?? ''}@cp-old`);
  expect(ctx.fake.readMountedAt(ctx.diskDir('a'))).toBe(`${ROOT}/disks/a`);

  expect(ctx.fake.listSnapshots()).toEqual([
    `${IMAGE}@base`,
    `${retired ?? ''}@cp-new`,
    `${retired ?? ''}@cp-old`,
  ]);

  // the newer checkpoint, now on the retired dataset, still restores
  await ctx.backend.restoreCheckpoint('a', 'cp-new', () => Promise.resolve());

  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)).toBe(`${retired ?? ''}@cp-new`);
});

test('a restore whose halt fails drops the staged clone and keeps the disk', async () => {
  using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-one');

  const failure = await readFailure(
    ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.reject(new Error('stop failed'))),
  );

  expect(String(failure)).toContain('stop failed');
  expect(ctx.fake.listDatasets()).not.toContain(`${ROOT}/staging/restore-a`);
  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)).toBe(`${IMAGE}@base`);
  expect(ctx.fake.readMountedAt(ctx.diskDir('a'))).toBe(`${ROOT}/disks/a`);
});

test('deleting checkpoints frees the disk a restore retired', async () => {
  using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-old');
  await ctx.createCheckpoint('a', 'cp-new');
  await ctx.backend.restoreCheckpoint('a', 'cp-old', () => Promise.resolve());
  await ctx.backend.removeCheckpoint('a', 'cp-new');

  expect(ctx.listRetired()).toHaveLength(1);

  // the restored disk is a clone of cp-old: the promote hands it over
  await ctx.backend.removeCheckpoint('a', 'cp-old');

  expect(ctx.listRetired()).toEqual([]);
  expect(ctx.fake.listSnapshots()).toEqual([`${IMAGE}@base`]);
  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)).toBe(`${IMAGE}@base`);
});

test('a fork from the live disk outlives its source', async () => {
  using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-one');

  ctx.live.impIds.add('b');

  await ctx.backend.createImpDisk('b', { kind: 'imp', impId: 'a' });

  const forkSnapshot = ctx.fake.readOrigin(`${ROOT}/disks/b`) ?? '';

  expect(forkSnapshot).toMatch(/^tank\/imp\/disks\/a@fork-/);
  expect(ctx.fake.isDeferred(forkSnapshot)).toBe(true);

  // destroy a: its rows are gone, so its checkpoint goes with it
  await ctx.backend.removeImpDisk('a', ['cp-one']);

  expect(ctx.listRetired()).toEqual([]);
  expect(ctx.fake.listDatasets()).toContain(`${ROOT}/disks/b`);
  expect(ctx.fake.readMountedAt(ctx.diskDir('a'))).toBeNull();

  await ctx.backend.removeImpDisk('b', []);

  expect(ctx.fake.listDatasets().filter((name) => name.startsWith(`${ROOT}/disks/`))).toEqual([]);
  expect(ctx.fake.listSnapshots()).toEqual([`${IMAGE}@base`]);
});

test('a fork from a checkpoint holds the snapshot until it is destroyed', async () => {
  using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-one');
  await ctx.backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-one' });

  expect(ctx.fake.readOrigin(`${ROOT}/disks/b`)).toBe(`${ROOT}/disks/a@cp-one`);

  await ctx.backend.removeCheckpoint('a', 'cp-one');

  expect(ctx.fake.isDeferred(`${ROOT}/disks/a@cp-one`)).toBe(true);

  await ctx.backend.removeImpDisk('b', []);

  expect(ctx.fake.listSnapshots()).toEqual([`${IMAGE}@base`]);
});

test('a removed image hands its blocks to the imps cloned from it', async () => {
  using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createImp('b');
  await ctx.backend.removeImage(DIGEST);

  // the first clone is promoted and owns the image's blocks; b clones its @base
  expect(ctx.listRetired()).toEqual([]);
  expect(ctx.fake.listDatasets()).not.toContain(IMAGE);
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'images', '9f2c'))).toBeNull();
  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)).toBeNull();
  expect(ctx.fake.readOrigin(`${ROOT}/disks/b`)).toBe(`${ROOT}/disks/a@base`);
  expect(ctx.fake.isDeferred(`${ROOT}/disks/a@base`)).toBe(true);

  // a goes first, while b still needs its @base
  await ctx.backend.removeImpDisk('a', []);
  await ctx.backend.removeImpDisk('b', []);

  expect(ctx.fake.listDatasets().filter((name) => name.startsWith(`${ROOT}/disks/`))).toEqual([]);
  expect(ctx.listRetired()).toEqual([]);
  expect(ctx.fake.listSnapshots()).toEqual([]);
});

// the swap after the halt, step by step; a crash before each one
const SWAP_STEPS = [
  { step: 'umount', before: (command: string) => command.startsWith('umount'), restored: false },
  {
    step: 'retire',
    before: (command: string) => command.startsWith(`zfs rename ${ROOT}/disks/a `),
    restored: false,
  },
  {
    step: 'rename',
    before: (command: string) => command.startsWith(`zfs rename ${ROOT}/staging/restore-a`),
    restored: true,
  },
  {
    step: 'mount',
    before: (command: string) => command.startsWith(`mount -t zfs ${ROOT}/disks/a`),
    restored: true,
  },
];

for (const swap of SWAP_STEPS) {
  test(`a restore cut short before the ${swap.step} is settled by the next start`, async () => {
    using ctx = await setupStarted();

    await ctx.createImp('a');
    await ctx.createCheckpoint('a', 'cp-one');

    const failure = await readFailure(
      ctx.backend.restoreCheckpoint('a', 'cp-one', () => {
        ctx.fake.crashBefore(swap.before);

        return Promise.resolve();
      }),
    );

    expect(failure).toBeInstanceOf(FakeZfsCrashError);

    await ctx.restartImpd(true);

    expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toEqual([]);
    expect(ctx.fake.readMountedAt(ctx.diskDir('a'))).toBe(`${ROOT}/disks/a`);

    const origin = ctx.fake.readOrigin(`${ROOT}/disks/a`) ?? '';

    expect(origin.endsWith('@cp-one')).toBe(swap.restored);
    expect(ctx.fake.listSnapshots().filter((name) => name.endsWith('@cp-one'))).toHaveLength(1);
  });
}

test('a restore cut short before its clone or during the halt leaves the disk', async () => {
  using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-one');

  ctx.fake.crashBefore((command) => command.startsWith('zfs clone'));

  const beforeClone = await readFailure(
    ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.resolve()),
  );

  expect(beforeClone).toBeInstanceOf(FakeZfsCrashError);

  await ctx.restartImpd(true);

  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)).toBe(`${IMAGE}@base`);

  // impd dies while it stops the VM: the clone is staged, the disk untouched
  await readFailure(
    ctx.backend.restoreCheckpoint('a', 'cp-one', () => {
      ctx.fake.crashBefore(() => true);

      return Promise.reject(new Error('impd died'));
    }),
  );

  await ctx.restartImpd(true);

  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)).toBe(`${IMAGE}@base`);
  expect(ctx.fake.listDatasets()).not.toContain(`${ROOT}/staging/restore-a`);
});

test('start remounts every disk and image after a container restart', async () => {
  using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createImp('b');
  await ctx.restartImpd(true);

  expect(ctx.fake.readMountedAt(ctx.diskDir('a'))).toBe(`${ROOT}/disks/a`);
  expect(ctx.fake.readMountedAt(ctx.diskDir('b'))).toBe(`${ROOT}/disks/b`);
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'images', '9f2c'))).toBe(IMAGE);
});

test('start drops disks, checkpoints and images the database no longer names', async () => {
  using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createImp('gone');
  await ctx.createCheckpoint('a', 'cp-kept');
  await ctx.createCheckpoint('a', 'cp-gone');

  // a fork snapshot whose clone never happened
  await ctx.fake.run(['zfs', 'snapshot', `${ROOT}/disks/a@fork-left`]);

  await ctx.restartImpd(true, {
    impIds: new Set(['a']),
    checkpointIds: new Set(['cp-kept']),
    imageDigests: new Set([DIGEST]),
  });

  expect(ctx.fake.listSnapshots()).toEqual([`${ROOT}/disks/a@cp-kept`, `${IMAGE}@base`]);
  expect(ctx.fake.listDatasets()).not.toContain(`${ROOT}/disks/gone`);
  expect(ctx.listRetired()).toEqual([]);
});

test('it reads the pool usage of the root dataset', async () => {
  using ctx = await setupStarted();

  const usage = await ctx.backend.readUsage();

  expect(usage).toEqual({
    usedBytes: 1_073_741_824,
    availableBytes: 9_663_676_416,
  });
});
