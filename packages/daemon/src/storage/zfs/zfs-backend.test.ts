import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { waitWithin } from '../../process/wait-within';
import { buildWatchdogSlot } from '../data-layout';
import { CheckpointIdTakenError } from '../storage-backend';
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
  const logs: string[] = [];

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
      log: (message) => {
        logs.push(message);
      },
    });

  const state = { backend: startBackend() };

  return {
    dataDir,
    fake,
    logs,
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

    // a reclaim still queued must not outlive the test
    [Symbol.asyncDispose]: async () => {
      await state.backend.waitForReclaim();

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

test('start refuses a userland and kernel module of different major versions', async () => {
  await using ctx = setupTest('3.0.0-1');

  const failure = await readFailure(ctx.backend.start(ctx.live));

  expect(String(failure)).toContain(
    'the userland is 2.2.2-0ubuntu9 but the kernel module is 3.0.0-1; they must match in major version',
  );
});

test('start warns about a minor version skew and goes on', async () => {
  await using ctx = setupTest('2.3.1-1');

  await ctx.backend.start(ctx.live);

  expect(ctx.logs).toContain(
    'impd: zfs: warning: the userland is 2.2.2-0ubuntu9 but the kernel module is 2.3.1-1',
  );

  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'mem'))).toBe(`${ROOT}/mem`);
});

test('start refuses a data dir that is not the root dataset', async () => {
  await using ctx = setupTest();

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
  await using ctx = setupTest();

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
  await using ctx = setupTest();

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
  await using ctx = setupTest();

  await ctx.backend.start(ctx.live);

  const failure = await readFailure(
    ctx.backend.createImage(DIGEST, () => Promise.reject(new Error('mkfs failed'))),
  );

  expect(String(failure)).toContain('mkfs failed');
  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toEqual([]);
});

test('an imp disk is a mounted clone of the image, with its own paths', async () => {
  await using ctx = await setupStarted();

  await ctx.createImp('a');

  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)).toBe(`${IMAGE}@base`);
  expect(ctx.fake.readMountedAt(ctx.diskDir('a'))).toBe(`${ROOT}/disks/a`);

  const paths = ctx.backend.resolveImpPaths('a');

  expect(paths.disk).toBe(join(ctx.diskDir('a'), 'rootfs.ext4'));
  expect(paths.memFile).toBe(join(ctx.dataDir, 'mem', 'a', 'mem'));
  expect(paths.vmIdentity).toBe(join(ctx.dataDir, 'imps', 'a', 'vm.json'));
});

test('a checkpoint is a snapshot sized by what was written, and its id must be new', async () => {
  await using ctx = await setupStarted();

  await ctx.createImp('a');

  const sizeBytes = await ctx.createCheckpoint('a', 'cp-one');

  expect(sizeBytes).toBe(65_536);
  expect(ctx.fake.commands).toContain(`zfs snapshot ${ROOT}/disks/a@cp-one`);

  await ctx.createImp('b');

  const failure = await readFailure(ctx.backend.createCheckpoint('b', 'cp-one'));

  expect(String(failure)).toContain('a snapshot named cp-one exists already');
});

test('a restore keeps every other checkpoint, older and newer', async () => {
  await using ctx = await setupStarted();

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
  await ctx.backend.waitForReclaim();

  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)).toBe(`${retired ?? ''}@cp-new`);
});

test('a restore whose halt fails drops the staged clone and keeps the disk', async () => {
  await using ctx = await setupStarted();

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
  await using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-old');
  await ctx.createCheckpoint('a', 'cp-new');
  await ctx.backend.restoreCheckpoint('a', 'cp-old', () => Promise.resolve());
  await ctx.backend.waitForReclaim();
  await ctx.backend.removeCheckpoint('a', 'cp-new');
  await ctx.backend.waitForReclaim();

  expect(ctx.listRetired()).toHaveLength(1);

  // the restored disk is a clone of cp-old: the promote hands it over
  await ctx.backend.removeCheckpoint('a', 'cp-old');
  await ctx.backend.waitForReclaim();

  expect(ctx.listRetired()).toEqual([]);
  expect(ctx.fake.listSnapshots()).toEqual([`${IMAGE}@base`]);
  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)).toBe(`${IMAGE}@base`);
});

test('a fork from the live disk outlives its source', async () => {
  await using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-one');

  ctx.live.impIds.add('b');

  await ctx.backend.createImpDisk('b', { kind: 'imp', impId: 'a' });

  const forkSnapshot = ctx.fake.readOrigin(`${ROOT}/disks/b`) ?? '';

  expect(forkSnapshot).toMatch(/^tank\/imp\/disks\/a@fork-/);
  expect(ctx.fake.isDeferred(forkSnapshot)).toBe(true);

  // destroy a: its rows are gone, so its checkpoint goes with it
  await ctx.backend.removeImpDisk('a', ['cp-one']);
  await ctx.backend.waitForReclaim();

  expect(ctx.listRetired()).toEqual([]);
  expect(ctx.fake.listDatasets()).toContain(`${ROOT}/disks/b`);
  expect(ctx.fake.readMountedAt(ctx.diskDir('a'))).toBeNull();

  await ctx.backend.removeImpDisk('b', []);
  await ctx.backend.waitForReclaim();
  await ctx.backend.waitForReclaim();

  expect(ctx.fake.listDatasets().filter((name) => name.startsWith(`${ROOT}/disks/`))).toEqual([]);
  expect(ctx.fake.listSnapshots()).toEqual([`${IMAGE}@base`]);
});

test('a fork from a checkpoint holds the snapshot until it is destroyed', async () => {
  await using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-one');
  await ctx.backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-one' });

  expect(ctx.fake.readOrigin(`${ROOT}/disks/b`)).toBe(`${ROOT}/disks/a@cp-one`);

  await ctx.backend.removeCheckpoint('a', 'cp-one');
  await ctx.backend.waitForReclaim();
  await ctx.backend.waitForReclaim();

  expect(ctx.fake.isDeferred(`${ROOT}/disks/a@cp-one`)).toBe(true);

  await ctx.backend.removeImpDisk('b', []);
  await ctx.backend.waitForReclaim();
  await ctx.backend.waitForReclaim();

  expect(ctx.fake.listSnapshots()).toEqual([`${IMAGE}@base`]);
});

test('a removed image hands its blocks to the imps cloned from it', async () => {
  await using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createImp('b');
  await ctx.backend.removeImage(DIGEST);
  await ctx.backend.waitForReclaim();

  // the first clone is promoted and owns the image's blocks; b clones its @base
  expect(ctx.listRetired()).toEqual([]);
  expect(ctx.fake.listDatasets()).not.toContain(IMAGE);
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'images', '9f2c'))).toBeNull();
  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)).toBeNull();
  expect(ctx.fake.readOrigin(`${ROOT}/disks/b`)).toBe(`${ROOT}/disks/a@base`);
  expect(ctx.fake.isDeferred(`${ROOT}/disks/a@base`)).toBe(true);

  // a goes first, while b still needs its @base
  await ctx.backend.removeImpDisk('a', []);
  await ctx.backend.waitForReclaim();
  await ctx.backend.removeImpDisk('b', []);
  await ctx.backend.waitForReclaim();

  expect(ctx.fake.listDatasets().filter((name) => name.startsWith(`${ROOT}/disks/`))).toEqual([]);
  expect(ctx.listRetired()).toEqual([]);
  expect(ctx.fake.listSnapshots()).toEqual([]);
});

test('a template is a clone of the live disk, made under hold, and reclaims cleanly', async () => {
  await using ctx = await setupStarted();

  const template = 'imp-0199a3b4-0000-7000-8000-000000000001';
  const templateName = `${ROOT}/images/${template}`;
  const held: string[] = [];

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-one');

  ctx.live.imageDigests.add(template);

  await ctx.backend.createImageFromImp(template, 'a', {
    hold: async (clone) => {
      held.push('hold');

      await clone();

      held.push('release');
    },
    write: (dir) => {
      held.push(`write ${dir.startsWith(join(ctx.dataDir, 'staging')) ? 'staging' : dir}`);

      return Promise.resolve();
    },
  });

  expect(held).toEqual(['hold', 'release', 'write staging']);
  expect(ctx.fake.readOrigin(templateName)).toMatch(/^tank\/imp\/disks\/a@fork-/);
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'images', template))).toBe(templateName);

  // two imps from the template, then the source, the template and the imps go
  ctx.live.impIds.add('c');
  ctx.live.impIds.add('d');

  await ctx.backend.createImpDisk('c', { kind: 'image', digest: template });
  await ctx.backend.createImpDisk('d', { kind: 'image', digest: template });

  expect(ctx.fake.readOrigin(`${ROOT}/disks/c`)).toBe(`${templateName}@base`);

  await ctx.backend.removeImpDisk('a', ['cp-one']);
  await ctx.backend.waitForReclaim();
  await ctx.backend.removeImage(template);
  await ctx.backend.waitForReclaim();
  await ctx.backend.removeImpDisk('c', []);
  await ctx.backend.waitForReclaim();
  await ctx.backend.removeImpDisk('d', []);
  await ctx.backend.waitForReclaim();

  expect(ctx.listRetired()).toEqual([]);
  expect(ctx.fake.listDatasets().filter((name) => name.startsWith(`${ROOT}/disks/`))).toEqual([]);
  expect(ctx.fake.listDatasets()).not.toContain(templateName);
  expect(ctx.fake.listSnapshots()).toEqual([`${IMAGE}@base`]);
});

test('a template whose write fails leaves no dataset, and the fork snapshot goes', async () => {
  await using ctx = await setupStarted();

  await ctx.createImp('a');

  const failure = await readFailure(
    ctx.backend.createImageFromImp('imp-x', 'a', {
      hold: (clone) => clone(),
      write: () => Promise.reject(new Error('no config')),
    }),
  );

  expect(failure).toMatchObject({ message: 'no config' });
  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toEqual([]);
  expect(ctx.fake.listSnapshots()).toEqual([`${IMAGE}@base`]);
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
    await using ctx = await setupStarted();

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
  await using ctx = await setupStarted();

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
  await using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createImp('b');
  await ctx.restartImpd(true);

  expect(ctx.fake.readMountedAt(ctx.diskDir('a'))).toBe(`${ROOT}/disks/a`);
  expect(ctx.fake.readMountedAt(ctx.diskDir('b'))).toBe(`${ROOT}/disks/b`);
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'images', '9f2c'))).toBe(IMAGE);
});

test('start drops disks, checkpoints and images the database no longer names', async () => {
  await using ctx = await setupStarted();

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
  await using ctx = await setupStarted();

  const usage = await ctx.backend.readUsage();

  expect(usage).toEqual({
    usedBytes: 1_073_741_824,
    availableBytes: 9_663_676_416,
  });
});

test('a checkpoint and a live fork never wait for a reclaim', async () => {
  await using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.backend.createImpDisk('b', { kind: 'imp', impId: 'a' });

  // retiring a needs a promote of b; it hangs until released
  const release = ctx.fake.blockBefore((command) => command.startsWith('zfs promote'));

  await ctx.backend.removeImpDisk('a', []);

  const frozenWork = Promise.all([
    ctx.createCheckpoint('b', 'cp-frozen'),
    ctx.backend.createImpDisk('c', { kind: 'imp', impId: 'b' }),
  ]);

  // well inside the agent's 10 s freeze
  const isDone = await waitWithin(frozenWork, 1000);

  expect(isDone).toBeTrue();
  expect(ctx.fake.commands.some((command) => command.startsWith('zfs promote'))).toBeFalse();

  release();

  await ctx.backend.waitForReclaim();

  expect(ctx.listRetired()).toEqual([]);
  expect(ctx.fake.readMountedAt(ctx.diskDir('c'))).toBe(`${ROOT}/disks/c`);
});

test('a swap whose retire fails remounts the old disk', async () => {
  await using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-one');

  ctx.fake.failOnce((command) => command.startsWith(`zfs rename ${ROOT}/disks/a `));

  const failure = await readFailure(
    ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.resolve()),
  );

  expect(String(failure)).toContain(`zfs rename ${ROOT}/disks/a`);
  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)).toBe(`${IMAGE}@base`);
  expect(ctx.fake.readMountedAt(ctx.diskDir('a'))).toBe(`${ROOT}/disks/a`);
  expect(ctx.fake.listDatasets()).not.toContain(`${ROOT}/staging/restore-a`);
});

test('a swap whose last rename fails finishes it', async () => {
  await using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-one');

  ctx.fake.failOnce((command) => command.startsWith(`zfs rename ${ROOT}/staging/restore-a`));

  const failure = await readFailure(
    ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.resolve()),
  );

  expect(String(failure)).toContain(`zfs rename ${ROOT}/staging/restore-a`);
  expect(ctx.fake.readOrigin(`${ROOT}/disks/a`)?.endsWith('@cp-one')).toBeTrue();
  expect(ctx.fake.readMountedAt(ctx.diskDir('a'))).toBe(`${ROOT}/disks/a`);
});

test('a failed halt is what a restore throws, even when its cleanup fails', async () => {
  await using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-one');

  ctx.fake.failOnce((command) => command === `zfs destroy ${ROOT}/staging/restore-a`);

  const failure = await readFailure(
    ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.reject(new Error('stop failed'))),
  );

  expect(String(failure)).toBe('Error: stop failed');

  expect(ctx.logs.some((line) => line.includes(`could not drop ${ROOT}/staging/restore-a`))).toBe(
    true,
  );

  // the next start drops it: the disk is still there
  await ctx.restartImpd(true);

  expect(ctx.fake.listDatasets()).not.toContain(`${ROOT}/staging/restore-a`);
});

test('a checkpoint id held by a deleted checkpoint a fork needs is taken', async () => {
  await using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-one');
  await ctx.backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-one' });
  await ctx.backend.removeCheckpoint('a', 'cp-one');

  const failure = await readFailure(ctx.backend.createCheckpoint('a', 'cp-one'));

  expect(failure).toBeInstanceOf(CheckpointIdTakenError);
});

test('start drops an image build a crash cut short, with its mount dir', async () => {
  await using ctx = await setupStarted();

  const staged = `${ROOT}/staging/image-crashed`;
  const dir = join(ctx.dataDir, 'staging', 'image-crashed');

  await ctx.fake.run(['zfs', 'create', staged]);

  mkdirSync(dir, { recursive: true });

  await ctx.fake.run(['mount', '-t', 'zfs', staged, dir]);
  await ctx.restartImpd(true);

  expect(ctx.fake.listDatasets()).not.toContain(staged);
  expect(existsSync(dir)).toBeFalse();
});

// a run's copies of imp a (with checkpoint cp-1) and the image, in the tree
async function setupBackupRun() {
  const ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-1');
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  return ctx;
}

const BACKUP_REQUEST = {
  runId: 'r1',
  imps: [{ impId: 'a', checkpointIds: ['cp-1'] }],
  imageDigests: [DIGEST],
};

test('a backup tree mounts read-only clones of the copy, checkpoints and image', async () => {
  await using ctx = await setupBackupRun();

  const tree = await ctx.backend.openBackupTree(BACKUP_REQUEST);

  const treeDir = join(ctx.dataDir, 'backup', 'tree');

  expect([...tree.impIds]).toEqual(['a']);
  expect([...tree.checkpointIds]).toEqual(['cp-1']);
  expect([...tree.imageDigests]).toEqual([DIGEST]);
  expect(ctx.fake.readMountedAt(join(treeDir, 'imps', 'a', 'disk'))).toBe(`${ROOT}/staging/bk-a`);

  const checkpointDir = join(treeDir, 'imps', 'a', 'checkpoints', 'cp-1');

  expect(ctx.fake.readMountedAt(checkpointDir)).toBe(`${ROOT}/staging/bkc-cp-1`);
  expect(ctx.fake.readMountedAt(join(treeDir, 'images', '9f2c'))).toBe(`${ROOT}/staging/bki-9f2c`);
  expect(ctx.fake.readProperty(`${ROOT}/staging/bk-a`, 'readonly')).toBe('on');

  for (const dir of [
    join(treeDir, 'imps', 'a', 'disk'),
    checkpointDir,
    join(treeDir, 'images', '9f2c'),
  ]) {
    expect({ dir, isReadOnly: ctx.fake.isReadOnlyAt(dir) }).toEqual({ dir, isReadOnly: true });
  }

  expect(ctx.fake.isReadOnlyAt(join(ctx.dataDir, 'imps', 'a', 'disk'))).toBeFalse();
  expect(ctx.fake.isDeferred(`${ROOT}/disks/a@bk-r1-a`)).toBeTrue();

  await tree.close();

  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toEqual([]);
  expect(ctx.fake.listSnapshots().filter((name) => name.includes('@bk-'))).toEqual([]);
  expect(ctx.fake.readMountedAt(join(treeDir, 'imps', 'a', 'disk'))).toBeNull();
});

test('an imp destroyed while restic reads its copy goes once the tree closes', async () => {
  await using ctx = await setupBackupRun();

  const tree = await ctx.backend.openBackupTree(BACKUP_REQUEST);

  await ctx.backend.removeImpDisk('a', ['cp-1']);
  await ctx.backend.waitForReclaim();

  // the staging clones hold the retired disk; a promote would take its snapshots
  expect(ctx.listRetired()).toHaveLength(1);
  expect(ctx.fake.commands.filter((command) => command.startsWith('zfs promote'))).toEqual([]);

  await tree.close();
  await ctx.backend.waitForReclaim();

  expect(ctx.listRetired()).toEqual([]);
  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toEqual([]);
});

test('a backup tree leaves out storage removed since the database copy', async () => {
  await using ctx = await setupBackupRun();

  await ctx.backend.removeCheckpoint('a', 'cp-1');

  const tree = await ctx.backend.openBackupTree({
    ...BACKUP_REQUEST,
    imps: [...BACKUP_REQUEST.imps, { impId: 'gone', checkpointIds: [] }],
  });

  expect([...tree.impIds]).toEqual(['a']);
  expect([...tree.checkpointIds]).toEqual([]);

  await tree.close();
});

test('start drops the clones and copies of a backup run a crash cut short', async () => {
  await using ctx = await setupBackupRun();

  await ctx.backend.createBackupCopy('a', 'r2', { isReusable: true });
  await ctx.backend.openBackupTree(BACKUP_REQUEST);
  await ctx.restartImpd(false);

  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toEqual([]);
  expect(ctx.fake.listSnapshots().filter((name) => name.includes('@bk-'))).toEqual([]);

  const treeDisk = join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'disk');

  expect(ctx.fake.readMountedAt(treeDisk)).toBeNull();
});

test('a backup tree that fails to open releases what it made', async () => {
  await using ctx = await setupBackupRun();

  ctx.fake.failOnce((command) => command.includes('staging/bki-'));

  const failure = await readFailure(ctx.backend.openBackupTree(BACKUP_REQUEST));

  expect(String(failure)).toContain('failed');
  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toEqual([]);
  expect(ctx.fake.listSnapshots().filter((name) => name.includes('@bk-'))).toEqual([]);
});

test('an empty disk is a dataset of its own holding a zero-length file', async () => {
  await using ctx = await setupStarted();

  await ctx.backend.createImpDisk('b', { kind: 'empty' });

  expect(ctx.fake.readOrigin(`${ROOT}/disks/b`)).toBeNull();

  const diskDir = ctx.diskDir('b');

  expect(ctx.fake.readMountedAt(diskDir)).toBe(`${ROOT}/disks/b`);
  expect(existsSync(join(diskDir, 'rootfs.ext4'))).toBeTrue();
});

test('dropUnnamed retires what the database does not name and leaves staging alone', async () => {
  await using ctx = await setupStarted();

  await ctx.createImp('a');
  await ctx.createImp('b');
  await ctx.createCheckpoint('a', 'cp-1');
  await ctx.createCheckpoint('a', 'cp-lost');

  // an image build in flight, and the memory of an imp long gone
  await ctx.fake.run(['zfs', 'create', `${ROOT}/staging/image-now`]);

  mkdirSync(join(ctx.dataDir, 'mem', 'gone'), { recursive: true });

  ctx.live.impIds.delete('b');
  ctx.live.checkpointIds.delete('cp-lost');

  const listed = await ctx.backend.dropUnnamed(ctx.live, { isDryRun: true });

  expect(listed).toEqual([
    { kind: 'checkpoint', id: 'cp-lost' },
    { kind: 'imp', id: 'b' },
    { kind: 'memory', id: 'gone' },
  ]);

  expect(ctx.fake.listDatasets()).toContain(`${ROOT}/disks/b`);

  const dropped = await ctx.backend.dropUnnamed(ctx.live, { isDryRun: false });

  await ctx.backend.waitForReclaim();

  expect(dropped).toEqual(listed);

  const left = ctx.fake.listDatasets();

  expect(left).not.toContain(`${ROOT}/disks/b`);
  expect(left).toContain(`${ROOT}/disks/a`);
  expect(left).toContain(`${ROOT}/staging/image-now`);
  expect(existsSync(join(ctx.dataDir, 'mem', 'gone'))).toBeFalse();
  expect(existsSync(join(ctx.dataDir, 'imps', 'b'))).toBeFalse();
  expect(ctx.fake.readMountedAt(ctx.diskDir('a'))).toBe(`${ROOT}/disks/a`);
  expect(ctx.fake.listSnapshots()).toContain(`${ROOT}/disks/a@cp-1`);
  expect(ctx.fake.listSnapshots()).not.toContain(`${ROOT}/disks/a@cp-lost`);
});

test('usage counts the retired checkpoints and is an upper bound under a fork', async () => {
  await using ctx = await setupStarted();

  const MIB = 1_048_576;

  await ctx.createImp('a');
  await ctx.createCheckpoint('a', 'cp-old');
  await ctx.createCheckpoint('a', 'cp-new');
  await ctx.backend.restoreCheckpoint('a', 'cp-old', () => Promise.resolve());
  await ctx.createImp('c');

  const imps = [
    { impId: 'a', checkpointIds: ['cp-old', 'cp-new'] },
    { impId: 'c', checkpointIds: [] },
  ];

  const before = await ctx.backend.measureUsage(imps);

  // the fake: each dataset holds 1 MiB of its own and refers to 3
  expect(before.imps.get('a')).toEqual({
    exclusiveBytes: 2 * MIB,
    sharedBytes: 2 * MIB,
    isUpperBound: false,
  });

  expect(before.imps.get('c')).toEqual({
    exclusiveBytes: MIB,
    sharedBytes: 2 * MIB,
    isUpperBound: false,
  });

  await ctx.backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-new' });

  const after = await ctx.backend.measureUsage(imps);

  expect(after.imps.get('a')?.isUpperBound).toBe(true);
  expect(after.imps.get('c')?.isUpperBound).toBe(false);
});

test('the watchdog slot sits on the root dataset, so a destroy removes it with the imp', async () => {
  await using ctx = await setupStarted();

  await ctx.createImp('a');

  const paths = ctx.backend.resolveImpPaths('a');
  const slot = buildWatchdogSlot(paths.dir);

  mkdirSync(slot.snapshotDir, { recursive: true });
  writeFileSync(slot.memFile, 'mem');

  const datasetDirs = [ctx.diskDir('a'), dirname(paths.memFile)];

  // as a destroy does: the disk through the backend, then the directory
  await ctx.backend.removeImpDisk('a', []);

  rmSync(paths.dir, { recursive: true });

  expect(datasetDirs.some((dir) => slot.snapshotDir.startsWith(`${dir}/`))).toBeFalse();
  expect(existsSync(slot.snapshotDir)).toBeFalse();
});
