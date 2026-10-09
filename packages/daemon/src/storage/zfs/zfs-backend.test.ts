import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { StubZfsCrashError, buildStubZfs } from '../../test-utils/build-stub-zfs';
import { buildWatchdogSlot } from '../data-layout';
import { CheckpointIdTakenError } from '../storage-backend';
import { createZfsBackend } from './zfs-backend';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const root = mkdtempSync(join(tmpdir(), 'impd-zfs-test-'));

  stack.defer(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const dataDir = join(root, 'host');
  const peerDir = join(root, 'peer');

  // each fake pool mounts its root dataset on its data dir, as
  // host/scripts/setup-storage.sh does; start refuses a data dir without it
  const fake = buildStubZfs({ root: 'tank/imp', rootDir: dataDir });
  const peerFake = buildStubZfs({ root: 'tank/imp', rootDir: peerDir });
  const log = mock<(message: string) => void>();

  // A new impd on the same pool and data dir, as after a crash or restart.
  // The kernel module matches the fake's userland, so start goes on. A
  // reclaim still queued must not outlive the test.
  const startBackend = () => {
    const backend = createZfsBackend({
      dataDir,
      root: 'tank/imp',
      run: fake.run,
      streams: fake.streams,
      readMounts: fake.readMounts,
      readModuleVersion: () => '2.2.2-0ubuntu9',
      log,
    });

    stack.defer(() => backend.waitForReclaim());

    return backend;
  };

  // the far host of a move, on its own pool
  const peerBackend = createZfsBackend({
    dataDir: peerDir,
    root: 'tank/imp',
    run: peerFake.run,
    streams: peerFake.streams,
    readMounts: peerFake.readMounts,
    readModuleVersion: () => '2.2.2-0ubuntu9',
    log: () => {},
  });

  stack.defer(() => peerBackend.waitForReclaim());

  return {
    dataDir,
    fake,
    log,
    backend: startBackend(),
    startBackend,
    peer: { dataDir: peerDir, fake: peerFake, backend: peerBackend },
  };
}

test('#start refuses a userland and kernel module of different major versions', () => {
  const ctx = setupTest();

  const backend = createZfsBackend({
    dataDir: ctx.dataDir,
    root: 'tank/imp',
    run: ctx.fake.run,
    readMounts: ctx.fake.readMounts,
    readModuleVersion: () => '3.0.0-1',
    log: ctx.log,
  });

  expect(
    backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() }),
  ).rejects.toThrowWithMessage(
    Error,
    'zfs: the userland is 2.2.2-0ubuntu9 but the kernel module is 3.0.0-1; they must match in major version',
  );
});

test('#start warns about a minor version skew and goes on', async () => {
  const ctx = setupTest();

  const backend = createZfsBackend({
    dataDir: ctx.dataDir,
    root: 'tank/imp',
    run: ctx.fake.run,
    readMounts: ctx.fake.readMounts,
    readModuleVersion: () => '2.3.1-1',
    log: ctx.log,
  });

  await backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(ctx.log).toHaveBeenCalledWith(
    'impd: zfs: warning: the userland is 2.2.2-0ubuntu9 but the kernel module is 2.3.1-1',
  );

  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'mem'))).toBe('tank/imp/mem');
});

test('#start refuses a host whose zfs kernel module is not loaded', () => {
  const ctx = setupTest();

  const backend = createZfsBackend({
    dataDir: ctx.dataDir,
    root: 'tank/imp',
    run: ctx.fake.run,
    readMounts: ctx.fake.readMounts,
    readModuleVersion: () => null,
  });

  expect(
    backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() }),
  ).rejects.toThrowWithMessage(
    Error,
    'zfs: the kernel module is not loaded (no /sys/module/zfs/version)',
  );
});

test('#start refuses a data dir that is not the root dataset', () => {
  const ctx = setupTest();

  const backend = createZfsBackend({
    dataDir: ctx.dataDir,
    root: 'tank/other',
    run: ctx.fake.run,
    readMounts: ctx.fake.readMounts,
    readModuleVersion: () => '2.2.2',
  });

  expect(
    backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() }),
  ).rejects.toThrowWithMessage(
    Error,
    `zfs: tank/other is not mounted on ${ctx.dataDir} (host/scripts/setup-storage.sh mounts it)`,
  );
});

test('#start refuses a memory dir that holds another dataset', async () => {
  const ctx = setupTest();

  await ctx.fake.run(['zfs', 'create', 'tank/imp/other']);

  mkdirSync(join(ctx.dataDir, 'mem'), { recursive: true });

  await ctx.fake.run(['mount', '-t', 'zfs', 'tank/imp/other', join(ctx.dataDir, 'mem')]);

  expect(
    ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() }),
  ).rejects.toThrowWithMessage(
    Error,
    `zfs: ${join(ctx.dataDir, 'mem')} has tank/imp/other mounted, not tank/imp/mem`,
  );
});

test('#start makes the datasets it needs and mounts the memory dataset', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(ctx.fake.commands.filter((command) => command.startsWith('zfs create'))).toStrictEqual([
    'zfs create tank/imp/mem',
    'zfs create -o recordsize=16K tank/imp/disks',
    'zfs create -o recordsize=16K tank/imp/images',
    'zfs create -o recordsize=16K tank/imp/staging',
    'zfs create tank/imp/retired',
    'zfs create -o refreservation=1G tank/imp/reserve',
  ]);

  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'mem'))).toBe('tank/imp/mem');
});

test('#start after a container restart makes no dataset again and remounts the memory dataset', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  ctx.fake.restart(true);

  const before = ctx.fake.commands.length;
  const restarted = ctx.startBackend();

  await restarted.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(
    ctx.fake.commands.slice(before).filter((command) => command.startsWith('zfs create')),
  ).toStrictEqual([]);

  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'mem'))).toBe('tank/imp/mem');
});

test('#createImage builds and snapshots an image in staging, then renames and mounts it', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  const before = ctx.fake.commands.length;
  const written = { dir: '', mounted: null as string | null };

  await ctx.backend.createImage('sha256:9f2c', (dir) => {
    written.dir = dir;
    written.mounted = ctx.fake.readMountedAt(dir);

    return Promise.resolve();
  });

  const changes = ctx.fake.commands
    .slice(before)
    .filter((command) => !command.startsWith('zfs list'));

  const staged = written.mounted ?? '';

  expect(staged).toMatch(/^tank\/imp\/staging\/image-/);

  expect(changes).toStrictEqual([
    `zfs create ${staged}`,
    `mount -t zfs ${staged} ${written.dir}`,
    `umount ${written.dir}`,
    `zfs snapshot ${staged}@base`,
    `zfs rename ${staged} tank/imp/images/9f2c`,
    `mount -t zfs tank/imp/images/9f2c ${join(ctx.dataDir, 'images', '9f2c')}`,
  ]);
});

test('#createImage leaves no dataset behind when the build fails', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(
    ctx.backend.createImage('sha256:9f2c', () => Promise.reject(new Error('mkfs failed'))),
  ).rejects.toThrowWithMessage(Error, 'mkfs failed');

  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toStrictEqual([]);
});

test('#createImpDisk makes an imp disk a mounted clone of the image', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });

  expect(ctx.fake.readOrigin('tank/imp/disks/a')).toBe('tank/imp/images/9f2c@base');
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'a', 'disk'))).toBe('tank/imp/disks/a');
});

test('#resolveImpPaths puts the disk in its dataset and the memory in the memory dataset', () => {
  const ctx = setupTest();
  const paths = ctx.backend.resolveImpPaths('a');

  expect(paths.disk).toBe(join(ctx.dataDir, 'imps', 'a', 'disk', 'rootfs.ext4'));
  expect(paths.memFile).toBe(join(ctx.dataDir, 'mem', 'a', 'mem'));
  expect(paths.vmIdentity).toBe(join(ctx.dataDir, 'imps', 'a', 'vm.json'));
});

test('#createImpDisk makes an empty disk a dataset of its own holding a zero-length file', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImpDisk('b', { kind: 'empty' });

  expect(ctx.fake.readOrigin('tank/imp/disks/b')).toBeNull();
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'b', 'disk'))).toBe('tank/imp/disks/b');
  expect(readdirSync(join(ctx.dataDir, 'imps', 'b', 'disk'))).toStrictEqual(['rootfs.ext4']);
});

test('#createImpDisk refuses a checkpoint that no snapshot holds', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });

  expect(
    ctx.backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-gone' }),
  ).rejects.toThrowWithMessage(Error, 'zfs: expected one snapshot named cp-gone, found 0');
});

test('#createCheckpoint takes a snapshot sized by what was written', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });

  const sizeBytes = await ctx.backend.createCheckpoint('a', 'cp-one');

  expect(sizeBytes).toBe(65_536);
  expect(ctx.fake.listSnapshots()).toContain('tank/imp/disks/a@cp-one');
});

test('#createCheckpoint refuses an id a snapshot of another disk has', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:9f2c' });

  expect(ctx.backend.createCheckpoint('b', 'cp-one')).rejects.toThrowWithMessage(
    CheckpointIdTakenError,
    'a snapshot named cp-one exists already',
  );
});

test('#createCheckpoint refuses the id of a deleted checkpoint a fork still needs', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');
  await ctx.backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-one' });
  await ctx.backend.removeCheckpoint('a', 'cp-one');

  expect(ctx.backend.createCheckpoint('a', 'cp-one')).rejects.toThrow(CheckpointIdTakenError);
});

test('#restoreCheckpoint stages a clone before the halt and keeps every other checkpoint', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-old');
  await ctx.backend.createCheckpoint('a', 'cp-new');

  const atHalt = { lastCommand: '' };

  const halted = await ctx.backend.restoreCheckpoint('a', 'cp-old', () => {
    atHalt.lastCommand = ctx.fake.commands.at(-1) ?? '';

    return Promise.resolve('halted');
  });

  const retired = ctx.fake.listDatasets().find((name) => name.startsWith('tank/imp/retired/'));

  invariant(retired);

  expect(halted).toBe('halted');
  expect(atHalt.lastCommand).toBe('zfs clone tank/imp/disks/a@cp-old tank/imp/staging/restore-a');
  expect(ctx.fake.readOrigin('tank/imp/disks/a')).toBe(`${retired}@cp-old`);
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'a', 'disk'))).toBe('tank/imp/disks/a');

  expect(ctx.fake.listSnapshots()).toStrictEqual([
    'tank/imp/images/9f2c@base',
    `${retired}@cp-new`,
    `${retired}@cp-old`,
  ]);
});

test('#restoreCheckpoint restores a newer checkpoint that an earlier restore retired', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-old');
  await ctx.backend.createCheckpoint('a', 'cp-new');
  await ctx.backend.restoreCheckpoint('a', 'cp-old', () => Promise.resolve());

  const retired = ctx.fake.listDatasets().find((name) => name.startsWith('tank/imp/retired/'));

  invariant(retired);

  await ctx.backend.restoreCheckpoint('a', 'cp-new', () => Promise.resolve());
  await ctx.backend.waitForReclaim();

  expect(ctx.fake.readOrigin('tank/imp/disks/a')).toBe(`${retired}@cp-new`);
});

test('#restoreCheckpoint drops the staged clone and keeps the disk when the halt fails', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');

  expect(
    ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.reject(new Error('stop failed'))),
  ).rejects.toThrowWithMessage(Error, 'stop failed');

  expect(ctx.fake.listDatasets()).not.toContain('tank/imp/staging/restore-a');
  expect(ctx.fake.readOrigin('tank/imp/disks/a')).toBe('tank/imp/images/9f2c@base');
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'a', 'disk'))).toBe('tank/imp/disks/a');
});

test('#restoreCheckpoint throws the failed halt even when dropping the clone fails, and logs it', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');

  ctx.fake.failOnce((command) => command === 'zfs destroy tank/imp/staging/restore-a');

  expect(
    ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.reject(new Error('stop failed'))),
  ).rejects.toThrowWithMessage(Error, 'stop failed');

  expect(ctx.log).toHaveBeenCalledWith(
    'impd: zfs: could not drop tank/imp/staging/restore-a: zfs destroy tank/imp/staging/restore-a exited 1: fake zfs: zfs destroy tank/imp/staging/restore-a failed',
  );
});

test('#start drops the clone a restore whose halt failed could not drop', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');

  ctx.fake.failOnce((command) => command === 'zfs destroy tank/imp/staging/restore-a');

  expect(
    ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.reject(new Error('stop failed'))),
  ).rejects.toThrowWithMessage(Error, 'stop failed');

  ctx.fake.restart(true);

  const restarted = ctx.startBackend();

  await restarted.start({
    impIds: new Set(['a']),
    checkpointIds: new Set(['cp-one']),
    imageDigests: new Set(['sha256:9f2c']),
  });

  expect(ctx.fake.listDatasets()).not.toContain('tank/imp/staging/restore-a');
});

test('#restoreCheckpoint remounts the old disk when the swap fails to retire it', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');

  ctx.fake.failOnce((command) => command.startsWith('zfs rename tank/imp/disks/a '));

  expect(ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.resolve())).rejects.toThrow(
    /^zfs rename tank\/imp\/disks\/a tank\/imp\/retired\/\S+ exited 1: /,
  );

  expect(ctx.fake.readOrigin('tank/imp/disks/a')).toBe('tank/imp/images/9f2c@base');
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'a', 'disk'))).toBe('tank/imp/disks/a');
  expect(ctx.fake.listDatasets()).not.toContain('tank/imp/staging/restore-a');
});

test('#restoreCheckpoint finishes the swap when its last rename fails', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');

  ctx.fake.failOnce((command) => command.startsWith('zfs rename tank/imp/staging/restore-a'));

  expect(ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.resolve())).rejects.toThrow(
    /^zfs rename tank\/imp\/staging\/restore-a tank\/imp\/disks\/a exited 1: /,
  );

  expect(ctx.fake.readOrigin('tank/imp/disks/a')).toEndWith('@cp-one');
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'a', 'disk'))).toBe('tank/imp/disks/a');
});

test.each([
  ['umount', /^umount /, false],
  ['retire', /^zfs rename tank\/imp\/disks\/a /, false],
  ['rename', /^zfs rename tank\/imp\/staging\/restore-a /, true],
  ['mount', /^mount -t zfs tank\/imp\/disks\/a /, true],
])(
  '#start settles a restore that a crash cut short before its %s (restored: %p)',
  async (_step, before, isRestored) => {
    const ctx = setupTest();

    await ctx.backend.start({
      impIds: new Set(),
      checkpointIds: new Set(),
      imageDigests: new Set(),
    });

    await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
    await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
    await ctx.backend.createCheckpoint('a', 'cp-one');

    expect(
      ctx.backend.restoreCheckpoint('a', 'cp-one', () => {
        ctx.fake.crashBefore((command) => before.test(command));

        return Promise.resolve();
      }),
    ).rejects.toThrow(StubZfsCrashError);

    ctx.fake.restart(true);

    const restarted = ctx.startBackend();

    await restarted.start({
      impIds: new Set(['a']),
      checkpointIds: new Set(['cp-one']),
      imageDigests: new Set(['sha256:9f2c']),
    });

    expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toStrictEqual([]);
    expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'a', 'disk'))).toBe('tank/imp/disks/a');
    expect(ctx.fake.readOrigin('tank/imp/disks/a')?.endsWith('@cp-one')).toBe(isRestored);
    expect(ctx.fake.listSnapshots().filter((name) => name.endsWith('@cp-one'))).toHaveLength(1);
  },
);

test('#start leaves the disk as it was after a crash before the restore clone', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');

  ctx.fake.crashBefore((command) => command.startsWith('zfs clone'));

  expect(ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.resolve())).rejects.toThrow(
    StubZfsCrashError,
  );

  ctx.fake.restart(true);

  const restarted = ctx.startBackend();

  await restarted.start({
    impIds: new Set(['a']),
    checkpointIds: new Set(['cp-one']),
    imageDigests: new Set(['sha256:9f2c']),
  });

  expect(ctx.fake.readOrigin('tank/imp/disks/a')).toBe('tank/imp/images/9f2c@base');
});

test('#start drops the staged clone and keeps the disk after impd died during the halt', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');

  expect(
    ctx.backend.restoreCheckpoint('a', 'cp-one', () => {
      ctx.fake.crashBefore(() => true);

      return Promise.reject(new Error('impd died'));
    }),
  ).rejects.toThrowWithMessage(Error, 'impd died');

  ctx.fake.restart(true);

  const restarted = ctx.startBackend();

  await restarted.start({
    impIds: new Set(['a']),
    checkpointIds: new Set(['cp-one']),
    imageDigests: new Set(['sha256:9f2c']),
  });

  expect(ctx.fake.readOrigin('tank/imp/disks/a')).toBe('tank/imp/images/9f2c@base');
  expect(ctx.fake.listDatasets()).not.toContain('tank/imp/staging/restore-a');
});

test('#removeCheckpoint frees the disk a restore retired once its last checkpoint goes', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-old');
  await ctx.backend.createCheckpoint('a', 'cp-new');
  await ctx.backend.restoreCheckpoint('a', 'cp-old', () => Promise.resolve());
  await ctx.backend.waitForReclaim();
  await ctx.backend.removeCheckpoint('a', 'cp-new');
  await ctx.backend.waitForReclaim();

  const retiredBefore = ctx.fake
    .listDatasets()
    .filter((name) => name.startsWith('tank/imp/retired/'));

  // the restored disk is a clone of cp-old: the promote hands it over
  await ctx.backend.removeCheckpoint('a', 'cp-old');
  await ctx.backend.waitForReclaim();

  expect(retiredBefore).toHaveLength(1);

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/retired/')),
  ).toStrictEqual([]);

  expect(ctx.fake.listSnapshots()).toStrictEqual(['tank/imp/images/9f2c@base']);
  expect(ctx.fake.readOrigin('tank/imp/disks/a')).toBe('tank/imp/images/9f2c@base');
});

test('#removeCheckpoint refuses a checkpoint id that two snapshots carry', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.fake.run(['zfs', 'snapshot', 'tank/imp/disks/a@cp-twice']);
  await ctx.fake.run(['zfs', 'snapshot', 'tank/imp/disks/b@cp-twice']);

  expect(ctx.backend.removeCheckpoint('a', 'cp-twice')).rejects.toThrowWithMessage(
    Error,
    'zfs: 2 snapshots are named cp-twice',
  );
});

test('#createImpDisk forks a live disk from a fork snapshot marked for deferred destroy', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createImpDisk('b', { kind: 'imp', impId: 'a' });

  const forkSnapshot = ctx.fake.readOrigin('tank/imp/disks/b');

  invariant(forkSnapshot);

  expect(forkSnapshot).toMatch(/^tank\/imp\/disks\/a@fork-/);
  expect(ctx.fake.isDeferred(forkSnapshot)).toBeTrue();
});

test('#removeImpDisk retires a fork source and its checkpoint while the fork lives on', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');
  await ctx.backend.createImpDisk('b', { kind: 'imp', impId: 'a' });
  await ctx.backend.removeImpDisk('a', ['cp-one']);
  await ctx.backend.waitForReclaim();

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/retired/')),
  ).toStrictEqual([]);

  expect(ctx.fake.listDatasets()).toContain('tank/imp/disks/b');
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'a', 'disk'))).toBeNull();
});

test('#removeImpDisk frees every snapshot once the fork goes after its source', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');
  await ctx.backend.createImpDisk('b', { kind: 'imp', impId: 'a' });
  await ctx.backend.removeImpDisk('a', ['cp-one']);
  await ctx.backend.waitForReclaim();
  await ctx.backend.removeImpDisk('b', []);
  await ctx.backend.waitForReclaim();
  await ctx.backend.waitForReclaim();

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/disks/')),
  ).toStrictEqual([]);

  expect(ctx.fake.listSnapshots()).toStrictEqual(['tank/imp/images/9f2c@base']);
});

test('#removeCheckpoint keeps a checkpoint a fork holds until the fork is destroyed', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');
  await ctx.backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-one' });

  const forkOrigin = ctx.fake.readOrigin('tank/imp/disks/b');

  await ctx.backend.removeCheckpoint('a', 'cp-one');
  await ctx.backend.waitForReclaim();
  await ctx.backend.waitForReclaim();

  const isDeferredWhileForked = ctx.fake.isDeferred('tank/imp/disks/a@cp-one');

  await ctx.backend.removeImpDisk('b', []);
  await ctx.backend.waitForReclaim();
  await ctx.backend.waitForReclaim();

  expect(forkOrigin).toBe('tank/imp/disks/a@cp-one');
  expect(isDeferredWhileForked).toBeTrue();
  expect(ctx.fake.listSnapshots()).toStrictEqual(['tank/imp/images/9f2c@base']);
});

test('#removeImage hands its blocks to the first imp cloned from it', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.removeImage('sha256:9f2c');
  await ctx.backend.waitForReclaim();

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/retired/')),
  ).toStrictEqual([]);

  expect(ctx.fake.listDatasets()).not.toContain('tank/imp/images/9f2c');
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'images', '9f2c'))).toBeNull();
  expect(ctx.fake.readOrigin('tank/imp/disks/a')).toBeNull();
  expect(ctx.fake.readOrigin('tank/imp/disks/b')).toBe('tank/imp/disks/a@base');
  expect(ctx.fake.isDeferred('tank/imp/disks/a@base')).toBeTrue();
});

test('#removeImpDisk frees a removed image once its clones go, the promoted one first', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.removeImage('sha256:9f2c');
  await ctx.backend.waitForReclaim();

  // a goes first, while b still needs its @base
  await ctx.backend.removeImpDisk('a', []);
  await ctx.backend.waitForReclaim();
  await ctx.backend.removeImpDisk('b', []);
  await ctx.backend.waitForReclaim();

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/disks/')),
  ).toStrictEqual([]);

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/retired/')),
  ).toStrictEqual([]);

  expect(ctx.fake.listSnapshots()).toStrictEqual([]);
});

test('#createImageFromImp clones the live disk under hold and writes it in staging', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });

  const held: string[] = [];

  await ctx.backend.createImageFromImp('imp-0199a3b4-0000-7000-8000-000000000001', 'a', {
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

  expect(held).toStrictEqual(['hold', 'release', 'write staging']);

  expect(ctx.fake.readOrigin('tank/imp/images/imp-0199a3b4-0000-7000-8000-000000000001')).toMatch(
    /^tank\/imp\/disks\/a@fork-/,
  );

  expect(
    ctx.fake.readMountedAt(join(ctx.dataDir, 'images', 'imp-0199a3b4-0000-7000-8000-000000000001')),
  ).toBe('tank/imp/images/imp-0199a3b4-0000-7000-8000-000000000001');
});

test('#removeImage reclaims a template, its source and the imps cloned from it', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');

  await ctx.backend.createImageFromImp('imp-0199a3b4-0000-7000-8000-000000000001', 'a', {
    hold: (clone) => clone(),
    write: () => Promise.resolve(),
  });

  await ctx.backend.createImpDisk('c', {
    kind: 'image',
    digest: 'imp-0199a3b4-0000-7000-8000-000000000001',
  });

  await ctx.backend.createImpDisk('d', {
    kind: 'image',
    digest: 'imp-0199a3b4-0000-7000-8000-000000000001',
  });

  const cloneOrigin = ctx.fake.readOrigin('tank/imp/disks/c');

  await ctx.backend.removeImpDisk('a', ['cp-one']);
  await ctx.backend.waitForReclaim();
  await ctx.backend.removeImage('imp-0199a3b4-0000-7000-8000-000000000001');
  await ctx.backend.waitForReclaim();
  await ctx.backend.removeImpDisk('c', []);
  await ctx.backend.waitForReclaim();
  await ctx.backend.removeImpDisk('d', []);
  await ctx.backend.waitForReclaim();

  expect(cloneOrigin).toBe('tank/imp/images/imp-0199a3b4-0000-7000-8000-000000000001@base');

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/retired/')),
  ).toStrictEqual([]);

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/disks/')),
  ).toStrictEqual([]);

  expect(ctx.fake.listDatasets()).not.toContain(
    'tank/imp/images/imp-0199a3b4-0000-7000-8000-000000000001',
  );

  expect(ctx.fake.listSnapshots()).toStrictEqual(['tank/imp/images/9f2c@base']);
});

test('#createImageFromImp leaves no dataset and drops the fork snapshot when the write fails', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });

  expect(
    ctx.backend.createImageFromImp('imp-x', 'a', {
      hold: (clone) => clone(),
      write: () => Promise.reject(new Error('no config')),
    }),
  ).rejects.toThrowWithMessage(Error, 'no config');

  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toStrictEqual([]);
  expect(ctx.fake.listSnapshots()).toStrictEqual(['tank/imp/images/9f2c@base']);
});

test('#start remounts every disk and image after a container restart', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:9f2c' });

  ctx.fake.restart(true);

  const restarted = ctx.startBackend();

  await restarted.start({
    impIds: new Set(['a', 'b']),
    checkpointIds: new Set(),
    imageDigests: new Set(['sha256:9f2c']),
  });

  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'a', 'disk'))).toBe('tank/imp/disks/a');
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'b', 'disk'))).toBe('tank/imp/disks/b');
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'images', '9f2c'))).toBe('tank/imp/images/9f2c');
});

test('#start on an older database keeps the newer checkpoints and the disks it does not know', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createImpDisk('gone', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-kept');
  await ctx.backend.createCheckpoint('a', 'cp-new');
  await ctx.backend.createCheckpoint('gone', 'cp-g1');

  // fork snapshots whose clones never happened
  await ctx.fake.run(['zfs', 'snapshot', 'tank/imp/disks/a@fork-left']);
  await ctx.fake.run(['zfs', 'snapshot', 'tank/imp/disks/gone@fork-left']);

  ctx.fake.restart(true);
  ctx.log.mockClear();

  const restarted = ctx.startBackend();

  await restarted.start({
    impIds: new Set(['a']),
    checkpointIds: new Set(['cp-kept']),
    imageDigests: new Set(['sha256:9f2c']),
  });

  expect(ctx.fake.listSnapshots()).toStrictEqual([
    'tank/imp/disks/a@cp-kept',
    'tank/imp/disks/a@cp-new',
    'tank/imp/disks/gone@cp-g1',
    'tank/imp/disks/gone@fork-left',
    'tank/imp/images/9f2c@base',
  ]);

  expect(ctx.fake.isDeferred('tank/imp/disks/gone@cp-g1')).toBeFalse();
  expect(ctx.fake.isDeferred('tank/imp/disks/a@cp-new')).toBeFalse();

  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'gone', 'disk'))).toBe(
    'tank/imp/disks/gone',
  );

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/retired/')),
  ).toStrictEqual([]);

  expect(
    ctx.log.mock.calls.map(([line]) => line).filter((line) => line.startsWith('impd: storage:')),
  ).toStrictEqual([
    'impd: storage: removed snapshot tank/imp/disks/a@fork-left',
    `impd: storage: kept orphan imp gone (tank/imp/disks/gone): 1.0 MiB, created ${ctx.fake.readCreatedAt('tank/imp/disks/gone').toISOString()}, snapshots: cp-g1, fork-left`,
    `impd: storage: kept orphan checkpoint cp-new (tank/imp/disks/a@cp-new): 0.1 MiB, created ${ctx.fake.readCreatedAt('tank/imp/disks/a@cp-new').toISOString()}, snapshots: none`,
    'impd: storage: kept 2 orphans the database does not name; `imp gc --orphans --dry-run` lists what `imp gc --orphans` would retire',
  ]);
});

test('#start after a lost database keeps the checkpoints a restore left in retired', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-old');
  await ctx.backend.createCheckpoint('a', 'cp-new');
  await ctx.backend.restoreCheckpoint('a', 'cp-old', () => Promise.resolve());
  await ctx.backend.waitForReclaim();

  const retired = ctx.fake.listDatasets().find((name) => name.startsWith('tank/imp/retired/'));

  invariant(retired);

  ctx.fake.restart(true);
  ctx.log.mockClear();

  const restarted = ctx.startBackend();

  await restarted.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/retired/')),
  ).toStrictEqual([retired]);

  expect(ctx.fake.listSnapshots()).toIncludeSameMembers([
    `${retired}@cp-old`,
    `${retired}@cp-new`,
    'tank/imp/images/9f2c@base',
  ]);

  expect(ctx.fake.isDeferred(`${retired}@cp-new`)).toBeFalse();

  expect(
    ctx.log.mock.calls
      .map(([line]) => line)
      .filter((line) => line.startsWith('impd: storage: kept orphan'))
      .map((line) => line.split(' (')[0]),
  ).toStrictEqual([
    'impd: storage: kept orphan imp a',
    'impd: storage: kept orphan image 9f2c',
    'impd: storage: kept orphan checkpoint cp-old',
    'impd: storage: kept orphan checkpoint cp-new',
  ]);
});

test('#dropUnnamed with orphans retires what a restore left in retired after a lost database', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-old');
  await ctx.backend.createCheckpoint('a', 'cp-new');
  await ctx.backend.restoreCheckpoint('a', 'cp-old', () => Promise.resolve());
  await ctx.backend.waitForReclaim();

  ctx.fake.restart(true);

  const restarted = ctx.startBackend();

  await restarted.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  const retired = await restarted.dropUnnamed(
    { impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() },
    { isDryRun: false, isOrphans: true },
  );

  await restarted.waitForReclaim();

  expect(retired.dropped).toStrictEqual([
    { kind: 'checkpoint', id: 'cp-old' },
    { kind: 'checkpoint', id: 'cp-new' },
    { kind: 'image', id: '9f2c' },
    { kind: 'imp', id: 'a' },
  ]);

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/retired/')),
  ).toStrictEqual([]);

  expect(ctx.fake.listSnapshots()).toStrictEqual([]);
});

test('#start after a lost database keeps every disk, image and checkpoint, and logs each', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImage('sha256:7e1d', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createCheckpoint('a', 'cp-2');
  await ctx.backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-1' });
  await ctx.backend.createCheckpoint('b', 'cp-b');
  await ctx.fake.run(['zfs', 'snapshot', 'tank/imp/disks/b@fork-left']);
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  mkdirSync(join(ctx.dataDir, 'mem', 'a'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'mem', 'a', 'mem'), 'memory');

  // an image with no `@base`: a build cut short, or not
  await ctx.fake.run(['zfs', 'create', 'tank/imp/images/half']);

  // a memory snapshot and a VM identity whose disks are gone
  mkdirSync(join(ctx.dataDir, 'mem', 'm1'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'mem', 'm1', 'vmstate'), 'vmstate');
  writeFileSync(join(ctx.dataDir, 'mem', 'm1', 'meta.json'), '{}');
  mkdirSync(join(ctx.dataDir, 'imps', 'v1'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'imps', 'v1', 'vm.json'), '{}');

  // an image build under its temporary name, and the empty directories two
  // destroys leave once their disks are retired
  await ctx.fake.run(['zfs', 'create', 'tank/imp/staging/image-crashed']);

  mkdirSync(join(ctx.dataDir, 'mem', 'done'), { recursive: true });
  mkdirSync(join(ctx.dataDir, 'imps', 'done', 'run'), { recursive: true });

  ctx.fake.restart(true);
  ctx.log.mockClear();

  const restarted = ctx.startBackend();

  await restarted.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(ctx.fake.listSnapshots()).toStrictEqual([
    'tank/imp/disks/a@bk-r1-a',
    'tank/imp/disks/a@cp-1',
    'tank/imp/disks/a@cp-2',
    'tank/imp/disks/b@cp-b',
    'tank/imp/disks/b@fork-left',
    'tank/imp/images/7e1d@base',
    'tank/imp/images/9f2c@base',
  ]);

  expect(ctx.fake.listSnapshots()).toSatisfyAll((name: string) => !ctx.fake.isDeferred(name));

  expect(
    ctx.fake.listDatasets().filter((name) => /\/(?:disks|images|staging)\//.test(name)),
  ).toStrictEqual([
    'tank/imp/disks/a',
    'tank/imp/disks/b',
    'tank/imp/images/7e1d',
    'tank/imp/images/9f2c',
    'tank/imp/images/half',
  ]);

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/retired/')),
  ).toStrictEqual([]);

  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'a', 'disk'))).toBe('tank/imp/disks/a');
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'b', 'disk'))).toBe('tank/imp/disks/b');
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'images', '7e1d'))).toBe('tank/imp/images/7e1d');
  expect(existsSync(join(ctx.dataDir, 'mem', 'a', 'mem'))).toBeTrue();
  expect(existsSync(join(ctx.dataDir, 'mem', 'm1', 'vmstate'))).toBeTrue();
  expect(existsSync(join(ctx.dataDir, 'imps', 'v1', 'vm.json'))).toBeTrue();
  expect(existsSync(join(ctx.dataDir, 'mem', 'done'))).toBeFalse();
  expect(existsSync(join(ctx.dataDir, 'imps', 'done'))).toBeFalse();

  // a directory's creation is its birth time on the test's filesystem
  expect(
    ctx.log.mock.calls
      .map(([line]) => line)
      .filter((line) => line.startsWith('impd: storage:'))
      .map((line) =>
        line.includes(ctx.dataDir)
          ? line.replace(/created \S+Z, snapshots: none$/, 'created <birth>, snapshots: none')
          : line,
      ),
  ).toStrictEqual([
    'impd: storage: removed imp done',
    'impd: storage: removed memory done',
    `impd: storage: kept orphan imp a (tank/imp/disks/a): 1.0 MiB, created ${ctx.fake.readCreatedAt('tank/imp/disks/a').toISOString()}, snapshots: cp-1, cp-2, bk-r1-a`,
    `impd: storage: kept orphan imp b (tank/imp/disks/b): 1.0 MiB, created ${ctx.fake.readCreatedAt('tank/imp/disks/b').toISOString()}, snapshots: cp-b, fork-left`,
    `impd: storage: kept orphan image 9f2c (tank/imp/images/9f2c): 1.0 MiB, created ${ctx.fake.readCreatedAt('tank/imp/images/9f2c').toISOString()}, snapshots: base`,
    `impd: storage: kept orphan image 7e1d (tank/imp/images/7e1d): 1.0 MiB, created ${ctx.fake.readCreatedAt('tank/imp/images/7e1d').toISOString()}, snapshots: base`,
    `impd: storage: kept orphan image half (tank/imp/images/half): 1.0 MiB, created ${ctx.fake.readCreatedAt('tank/imp/images/half').toISOString()}, snapshots: none`,
    `impd: storage: kept orphan imp v1 (${ctx.dataDir}/imps/v1): 0.0 MiB, created <birth>, snapshots: none`,
    `impd: storage: kept orphan memory m1 (${ctx.dataDir}/mem/m1): 0.0 MiB, created <birth>, snapshots: none`,
    'impd: storage: kept 7 orphans the database does not name; `imp gc --orphans --dry-run` lists what `imp gc --orphans` would retire',
  ]);
});

test('#dropUnnamed without orphans keeps every orphan of a lost database and changes nothing', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImage('sha256:7e1d', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createCheckpoint('a', 'cp-2');
  await ctx.backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-1' });
  await ctx.backend.createCheckpoint('b', 'cp-b');
  await ctx.fake.run(['zfs', 'snapshot', 'tank/imp/disks/b@fork-left']);
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  mkdirSync(join(ctx.dataDir, 'mem', 'a'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'mem', 'a', 'mem'), 'memory');

  await ctx.fake.run(['zfs', 'create', 'tank/imp/images/half']);

  mkdirSync(join(ctx.dataDir, 'mem', 'm1'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'mem', 'm1', 'vmstate'), 'vmstate');
  mkdirSync(join(ctx.dataDir, 'imps', 'v1'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'imps', 'v1', 'vm.json'), '{}');

  ctx.fake.restart(true);

  const restarted = ctx.startBackend();

  await restarted.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  const before = ctx.fake.commands.length;

  const swept = await restarted.dropUnnamed(
    { impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() },
    { isDryRun: false, isOrphans: false },
  );

  await restarted.waitForReclaim();

  expect(swept.dropped).toStrictEqual([]);

  expect(swept.kept.map((orphan) => `${orphan.kind} ${orphan.id}`)).toStrictEqual([
    'imp a',
    'imp b',
    'image 9f2c',
    'image 7e1d',
    'image half',
    'imp v1',
    'memory m1',
  ]);

  expect(
    ctx.fake.commands.slice(before).filter((command) => !command.startsWith('zfs list')),
  ).toStrictEqual([]);
});

test('#dropUnnamed with orphans in a dry run lists each orphan of a lost database and changes nothing', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImage('sha256:7e1d', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createCheckpoint('a', 'cp-2');
  await ctx.backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-1' });
  await ctx.backend.createCheckpoint('b', 'cp-b');
  await ctx.fake.run(['zfs', 'snapshot', 'tank/imp/disks/b@fork-left']);
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  mkdirSync(join(ctx.dataDir, 'mem', 'a'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'mem', 'a', 'mem'), 'memory');

  await ctx.fake.run(['zfs', 'create', 'tank/imp/images/half']);

  mkdirSync(join(ctx.dataDir, 'mem', 'm1'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'mem', 'm1', 'vmstate'), 'vmstate');
  mkdirSync(join(ctx.dataDir, 'imps', 'v1'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'imps', 'v1', 'vm.json'), '{}');

  ctx.fake.restart(true);

  const restarted = ctx.startBackend();

  await restarted.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  const snapshotsBefore = ctx.fake.listSnapshots();

  const listed = await restarted.dropUnnamed(
    { impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() },
    { isDryRun: true, isOrphans: true },
  );

  expect(listed).toStrictEqual({
    dropped: [
      { kind: 'checkpoint', id: 'cp-1' },
      { kind: 'checkpoint', id: 'cp-2' },
      { kind: 'checkpoint', id: 'cp-b' },
      { kind: 'snapshot', id: 'tank/imp/disks/b@fork-left' },
      { kind: 'snapshot', id: 'tank/imp/disks/a@bk-r1-a' },
      { kind: 'image', id: '9f2c' },
      { kind: 'image', id: '7e1d' },
      { kind: 'image', id: 'half' },
      { kind: 'imp', id: 'a' },
      { kind: 'imp', id: 'b' },
      { kind: 'imp', id: 'v1' },
      { kind: 'memory', id: 'a' },
      { kind: 'memory', id: 'm1' },
    ],
    kept: [],
  });

  expect(ctx.fake.listSnapshots()).toStrictEqual(snapshotsBefore);
});

test('#dropUnnamed with orphans retires every orphan of a lost database', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImage('sha256:7e1d', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createCheckpoint('a', 'cp-2');
  await ctx.backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-1' });
  await ctx.backend.createCheckpoint('b', 'cp-b');
  await ctx.fake.run(['zfs', 'snapshot', 'tank/imp/disks/b@fork-left']);
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  mkdirSync(join(ctx.dataDir, 'mem', 'a'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'mem', 'a', 'mem'), 'memory');

  await ctx.fake.run(['zfs', 'create', 'tank/imp/images/half']);

  mkdirSync(join(ctx.dataDir, 'mem', 'm1'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'mem', 'm1', 'vmstate'), 'vmstate');
  mkdirSync(join(ctx.dataDir, 'imps', 'v1'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'imps', 'v1', 'vm.json'), '{}');

  ctx.fake.restart(true);

  const restarted = ctx.startBackend();

  await restarted.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  const retired = await restarted.dropUnnamed(
    { impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() },
    { isDryRun: false, isOrphans: true },
  );

  await restarted.waitForReclaim();

  expect(retired.dropped).toHaveLength(13);

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/retired/')),
  ).toStrictEqual([]);

  expect(ctx.fake.listSnapshots()).toStrictEqual([]);

  expect(ctx.fake.listDatasets().filter((name) => /\/(?:disks|images)\//.test(name))).toStrictEqual(
    [],
  );

  expect(readdirSync(join(ctx.dataDir, 'mem'))).toStrictEqual([]);
  expect(readdirSync(join(ctx.dataDir, 'imps'))).toStrictEqual([]);
});

test('#dropUnnamed in a dry run lists the memory of an imp long gone and keeps an unnamed disk', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createCheckpoint('a', 'cp-lost');

  mkdirSync(join(ctx.dataDir, 'mem', 'gone'), { recursive: true });

  const listed = await ctx.backend.dropUnnamed(
    {
      impIds: new Set(['a']),
      checkpointIds: new Set(['cp-1']),
      imageDigests: new Set(['sha256:9f2c']),
    },
    { isDryRun: true, isOrphans: false },
  );

  expect(listed).toStrictEqual({
    dropped: [{ kind: 'memory', id: 'gone' }],
    kept: [
      {
        kind: 'imp',
        id: 'b',
        location: 'tank/imp/disks/b',
        bytes: 1_048_576,
        createdAt: ctx.fake.readCreatedAt('tank/imp/disks/b'),
        snapshots: [],
      },
      {
        kind: 'checkpoint',
        id: 'cp-lost',
        location: 'tank/imp/disks/a@cp-lost',
        bytes: 65_536,
        createdAt: ctx.fake.readCreatedAt('tank/imp/disks/a@cp-lost'),
        snapshots: [],
      },
    ],
  });

  expect(existsSync(join(ctx.dataDir, 'mem', 'gone'))).toBeTrue();
});

test('#dropUnnamed drops what a crash left, keeps an unnamed disk and leaves staging alone', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createCheckpoint('a', 'cp-lost');

  // an image build in flight, and the memory of an imp long gone
  await ctx.fake.run(['zfs', 'create', 'tank/imp/staging/image-now']);

  mkdirSync(join(ctx.dataDir, 'mem', 'gone'), { recursive: true });

  const dropped = await ctx.backend.dropUnnamed(
    {
      impIds: new Set(['a']),
      checkpointIds: new Set(['cp-1']),
      imageDigests: new Set(['sha256:9f2c']),
    },
    { isDryRun: false, isOrphans: false },
  );

  await ctx.backend.waitForReclaim();

  expect(dropped.dropped).toStrictEqual([{ kind: 'memory', id: 'gone' }]);

  expect(ctx.fake.listDatasets()).toIncludeAllMembers([
    'tank/imp/disks/a',
    'tank/imp/disks/b',
    'tank/imp/staging/image-now',
  ]);

  expect(existsSync(join(ctx.dataDir, 'mem', 'gone'))).toBeFalse();
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'b', 'disk'))).toBe('tank/imp/disks/b');

  expect(ctx.fake.listSnapshots()).toIncludeAllMembers([
    'tank/imp/disks/a@cp-1',
    'tank/imp/disks/a@cp-lost',
  ]);
});

test('#dropUnnamed with orphans retires an unnamed disk and checkpoint and leaves staging alone', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createCheckpoint('a', 'cp-lost');
  await ctx.fake.run(['zfs', 'create', 'tank/imp/staging/image-now']);

  const retired = await ctx.backend.dropUnnamed(
    {
      impIds: new Set(['a']),
      checkpointIds: new Set(['cp-1']),
      imageDigests: new Set(['sha256:9f2c']),
    },
    { isDryRun: false, isOrphans: true },
  );

  await ctx.backend.waitForReclaim();

  expect(retired).toStrictEqual({
    dropped: [
      { kind: 'checkpoint', id: 'cp-lost' },
      { kind: 'imp', id: 'b' },
    ],
    kept: [],
  });

  expect(ctx.fake.listSnapshots()).not.toContain('tank/imp/disks/a@cp-lost');
  expect(ctx.fake.listDatasets()).not.toContain('tank/imp/disks/b');
  expect(existsSync(join(ctx.dataDir, 'imps', 'b'))).toBeFalse();
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'a', 'disk'))).toBe('tank/imp/disks/a');
  expect(ctx.fake.listDatasets()).toContain('tank/imp/staging/image-now');
});

test('#readUsage reads the pool usage of the root dataset', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  const usage = await ctx.backend.readUsage();

  expect(usage).toStrictEqual({ usedBytes: 1_073_741_824, availableBytes: 9_663_676_416 });
});

test('#createCheckpoint and a live fork run while a reclaim waits on its promote', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createImpDisk('b', { kind: 'imp', impId: 'a' });

  // retiring a needs a promote of b; it waits until released
  const block = ctx.fake.blockBefore((command) => command.startsWith('zfs promote'));

  await ctx.backend.removeImpDisk('a', []);

  await block.reached;

  await Promise.all([
    ctx.backend.createCheckpoint('b', 'cp-frozen'),
    ctx.backend.createImpDisk('c', { kind: 'imp', impId: 'b' }),
  ]);

  const hasPromoted = ctx.fake.commands.some((command) => command.startsWith('zfs promote'));

  block.release();

  await ctx.backend.waitForReclaim();

  expect(hasPromoted).toBeFalse();
  expect(ctx.fake.listSnapshots()).toContain('tank/imp/disks/b@cp-frozen');
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'imps', 'c', 'disk'))).toBe('tank/imp/disks/c');
});

test.each([
  ['snapshot', /^zfs snapshot .+@base$/],
  ['rename', /^zfs rename tank\/imp\/staging\//],
])(
  '#start drops an image build that a crash cut short before its %s, so a re-pull builds it again',
  async (_step, before) => {
    const ctx = setupTest();

    await ctx.backend.start({
      impIds: new Set(),
      checkpointIds: new Set(),
      imageDigests: new Set(),
    });

    ctx.fake.crashBefore((command) => before.test(command));

    expect(ctx.backend.createImage('sha256:9f2c', () => Promise.resolve())).rejects.toThrow(
      StubZfsCrashError,
    );

    ctx.fake.restart(true);

    const restarted = ctx.startBackend();

    await restarted.start({
      impIds: new Set(),
      checkpointIds: new Set(),
      imageDigests: new Set(['sha256:9f2c']),
    });

    const datasetsAfterStart = ctx.fake.listDatasets();

    await restarted.createImage('sha256:9f2c', () => Promise.resolve());
    await restarted.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });

    expect(datasetsAfterStart.filter((name) => name.includes('/staging/'))).toStrictEqual([]);
    expect(datasetsAfterStart).not.toContain('tank/imp/images/9f2c');
    expect(ctx.fake.readOrigin('tank/imp/disks/a')).toBe('tank/imp/images/9f2c@base');
  },
);

test('#start mounts an image whose build a crash cut short before its mount', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  ctx.fake.crashBefore((command) => command.startsWith('mount -t zfs tank/imp/images/9f2c '));

  expect(ctx.backend.createImage('sha256:9f2c', () => Promise.resolve())).rejects.toThrow(
    StubZfsCrashError,
  );

  ctx.fake.restart(true);

  const restarted = ctx.startBackend();

  await restarted.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(['sha256:9f2c']),
  });

  await restarted.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });

  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toStrictEqual([]);
  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'images', '9f2c'))).toBe('tank/imp/images/9f2c');
  expect(ctx.fake.readOrigin('tank/imp/disks/a')).toBe('tank/imp/images/9f2c@base');
});

test('#start drops an image build a crash cut short, with its mount dir', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.fake.run(['zfs', 'create', 'tank/imp/staging/image-crashed']);

  mkdirSync(join(ctx.dataDir, 'staging', 'image-crashed'), { recursive: true });

  await ctx.fake.run([
    'mount',
    '-t',
    'zfs',
    'tank/imp/staging/image-crashed',
    join(ctx.dataDir, 'staging', 'image-crashed'),
  ]);

  ctx.fake.restart(true);

  const restarted = ctx.startBackend();

  await restarted.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(ctx.fake.listDatasets()).not.toContain('tank/imp/staging/image-crashed');
  expect(existsSync(join(ctx.dataDir, 'staging', 'image-crashed'))).toBeFalse();
});

test('#openBackupTree mounts read-only clones of the copy, checkpoints and image', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  const tree = await ctx.backend.openBackupTree({
    runId: 'r1',
    imps: [{ impId: 'a', checkpointIds: ['cp-1'] }],
    imageDigests: ['sha256:9f2c'],
  });

  onTestFinished(() => tree.close());

  expect([...tree.impIds]).toStrictEqual(['a']);
  expect([...tree.checkpointIds]).toStrictEqual(['cp-1']);
  expect([...tree.imageDigests]).toStrictEqual(['sha256:9f2c']);

  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'disk'))).toBe(
    'tank/imp/staging/bk-a',
  );

  expect(
    ctx.fake.readMountedAt(join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'checkpoints', 'cp-1')),
  ).toBe('tank/imp/staging/bkc-cp-1');

  expect(ctx.fake.readMountedAt(join(ctx.dataDir, 'backup', 'tree', 'images', '9f2c'))).toBe(
    'tank/imp/staging/bki-9f2c',
  );

  expect(ctx.fake.readProperty('tank/imp/staging/bk-a', 'readonly')).toBe('on');

  expect(
    [
      join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'disk'),
      join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'checkpoints', 'cp-1'),
      join(ctx.dataDir, 'backup', 'tree', 'images', '9f2c'),
    ].filter((dir) => !ctx.fake.isReadOnlyAt(dir)),
  ).toStrictEqual([]);

  expect(ctx.fake.isReadOnlyAt(join(ctx.dataDir, 'imps', 'a', 'disk'))).toBeFalse();
  expect(ctx.fake.isDeferred('tank/imp/disks/a@bk-r1-a')).toBeTrue();
});

test('#openBackupTree gives a close that drops the clones and the copy snapshots', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  const tree = await ctx.backend.openBackupTree({
    runId: 'r1',
    imps: [{ impId: 'a', checkpointIds: ['cp-1'] }],
    imageDigests: ['sha256:9f2c'],
  });

  await tree.close();

  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toStrictEqual([]);
  expect(ctx.fake.listSnapshots().filter((name) => name.includes('@bk-'))).toStrictEqual([]);

  expect(
    ctx.fake.readMountedAt(join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'disk')),
  ).toBeNull();
});

test('#removeImpDisk holds back the reclaim of an imp that restic reads until the tree closes', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  const tree = await ctx.backend.openBackupTree({
    runId: 'r1',
    imps: [{ impId: 'a', checkpointIds: ['cp-1'] }],
    imageDigests: ['sha256:9f2c'],
  });

  await ctx.backend.removeImpDisk('a', ['cp-1']);
  await ctx.backend.waitForReclaim();

  // the staging clones hold the retired disk; a promote would take its snapshots
  const retiredWhileOpen = ctx.fake
    .listDatasets()
    .filter((name) => name.startsWith('tank/imp/retired/'));

  const promotesWhileOpen = ctx.fake.commands.filter((command) =>
    command.startsWith('zfs promote'),
  );

  await tree.close();
  await ctx.backend.waitForReclaim();

  expect(retiredWhileOpen).toHaveLength(1);
  expect(promotesWhileOpen).toStrictEqual([]);

  expect(
    ctx.fake.listDatasets().filter((name) => name.startsWith('tank/imp/retired/')),
  ).toStrictEqual([]);

  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toStrictEqual([]);
});

test('#openBackupTree leaves out storage removed since the database copy', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });
  await ctx.backend.removeCheckpoint('a', 'cp-1');

  const tree = await ctx.backend.openBackupTree({
    runId: 'r1',
    imps: [
      { impId: 'a', checkpointIds: ['cp-1'] },
      { impId: 'gone', checkpointIds: [] },
    ],
    imageDigests: ['sha256:9f2c'],
  });

  onTestFinished(() => tree.close());

  expect([...tree.impIds]).toStrictEqual(['a']);
  expect([...tree.checkpointIds]).toStrictEqual([]);
});

test('#openBackupTree refuses a tree in which a mount is still in place', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  mkdirSync(join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'disk'), { recursive: true });

  await ctx.fake.run([
    'mount',
    '-t',
    'zfs',
    'tank/imp/disks/a',
    join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'disk'),
  ]);

  expect(
    ctx.backend.openBackupTree({
      runId: 'r1',
      imps: [{ impId: 'a', checkpointIds: [] }],
      imageDigests: [],
    }),
  ).rejects.toThrowWithMessage(
    Error,
    `zfs: ${join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'disk')} in the backup tree is still mounted`,
  );
});

test('#start drops the clones and copies of a backup run a crash cut short', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });
  await ctx.backend.createBackupCopy('a', 'r2', { isReusable: true });

  await ctx.backend.openBackupTree({
    runId: 'r1',
    imps: [{ impId: 'a', checkpointIds: ['cp-1'] }],
    imageDigests: ['sha256:9f2c'],
  });

  ctx.fake.restart(false);

  const restarted = ctx.startBackend();

  await restarted.start({
    impIds: new Set(['a']),
    checkpointIds: new Set(['cp-1']),
    imageDigests: new Set(['sha256:9f2c']),
  });

  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toStrictEqual([]);
  expect(ctx.fake.listSnapshots().filter((name) => name.includes('@bk-'))).toStrictEqual([]);

  expect(
    ctx.fake.readMountedAt(join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'disk')),
  ).toBeNull();
});

test('#openBackupTree releases what it made when it fails to open', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  ctx.fake.failOnce((command) => command.includes('staging/bki-'));

  expect(
    ctx.backend.openBackupTree({
      runId: 'r1',
      imps: [{ impId: 'a', checkpointIds: ['cp-1'] }],
      imageDigests: ['sha256:9f2c'],
    }),
  ).rejects.toThrow(/^zfs clone .+ tank\/imp\/staging\/bki-9f2c exited 1: /);

  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toStrictEqual([]);
  expect(ctx.fake.listSnapshots().filter((name) => name.includes('@bk-'))).toStrictEqual([]);
});

test('#measureUsage counts the checkpoints a restore retired against the imp', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-old');
  await ctx.backend.createCheckpoint('a', 'cp-new');
  await ctx.backend.restoreCheckpoint('a', 'cp-old', () => Promise.resolve());
  await ctx.backend.createImpDisk('c', { kind: 'image', digest: 'sha256:9f2c' });

  const usage = await ctx.backend.measureUsage([
    { impId: 'a', checkpointIds: ['cp-old', 'cp-new'] },
    { impId: 'c', checkpointIds: [] },
  ]);

  // the fake: each dataset holds 1 MiB of its own and refers to 3
  expect(usage.imps.get('a')).toStrictEqual({
    exclusiveBytes: 2_097_152,
    sharedBytes: 2_097_152,
    isUpperBound: false,
  });

  expect(usage.imps.get('c')).toStrictEqual({
    exclusiveBytes: 1_048_576,
    sharedBytes: 2_097_152,
    isUpperBound: false,
  });
});

test('#measureUsage gives an upper bound for an imp a fork shares blocks with', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-old');
  await ctx.backend.createCheckpoint('a', 'cp-new');
  await ctx.backend.restoreCheckpoint('a', 'cp-old', () => Promise.resolve());
  await ctx.backend.createImpDisk('c', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-new' });

  const usage = await ctx.backend.measureUsage([
    { impId: 'a', checkpointIds: ['cp-old', 'cp-new'] },
    { impId: 'c', checkpointIds: [] },
  ]);

  expect(usage.imps.get('a')?.isUpperBound).toBeTrue();
  expect(usage.imps.get('c')?.isUpperBound).toBeFalse();
});

test('#removeImpDisk leaves no watchdog slot behind, since it sits on the root dataset', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });

  const paths = ctx.backend.resolveImpPaths('a');
  const slot = buildWatchdogSlot(paths.dir);

  mkdirSync(slot.snapshotDir, { recursive: true });
  writeFileSync(slot.memFile, 'mem');

  // as a destroy does: the disk through the backend, then the directory
  await ctx.backend.removeImpDisk('a', []);

  rmSync(paths.dir, { recursive: true });

  expect(
    [join(ctx.dataDir, 'imps', 'a', 'disk'), dirname(paths.memFile)].filter((dir) =>
      slot.snapshotDir.startsWith(`${dir}/`),
    ),
  ).toStrictEqual([]);

  expect(existsSync(slot.snapshotDir)).toBeFalse();
});

test('#openMoveSource plans each checkpoint incremental from the one before, then the disk', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');
  await ctx.backend.createCheckpoint('a', 'cp-two');

  const source = await ctx.backend.openMoveSource('a', ['cp-one', 'cp-two'], 'zfs');

  onTestFinished(() => source.close());

  if (source.kind !== 'zfs') {
    throw new Error('expected a ZFS move source');
  }

  expect(source.steps.map((step) => [step.checkpointId, step.dataset, step.base])).toStrictEqual([
    ['cp-one', 0, null],
    ['cp-two', 0, 0],
    [null, 0, 1],
  ]);
});

test('#receiveMoveSnapshots lands each checkpoint and the disk a ZFS move sends', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');
  await ctx.backend.createCheckpoint('a', 'cp-two');

  await ctx.peer.backend.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  const source = await ctx.backend.openMoveSource('a', ['cp-one', 'cp-two'], 'zfs');

  // the test closes the source itself; the fallback closes it only once
  const closing = { done: null as Promise<void> | null };

  onTestFinished(() => (closing.done ??= source.close()));

  if (source.kind !== 'zfs') {
    throw new Error('expected a ZFS move source');
  }

  const ids = ['cp-moved1', 'cp-moved2'];

  const received = await ctx.peer.backend.receiveMoveSnapshots(
    'a',
    source.steps.map((step) => ({
      isCheckpoint: step.checkpointId !== null,
      dataset: step.dataset,
      base: step.base,
    })),
    (index) => source.steps[index]?.open().stdout ?? new ReadableStream(),
    () => ids.shift() ?? 'cp-none',
  );

  await (closing.done ??= source.close());

  expect(received.map((checkpoint) => checkpoint.id)).toStrictEqual(['cp-moved1', 'cp-moved2']);

  expect(ctx.peer.fake.listSnapshots().filter((name) => name.includes('/disks/'))).toStrictEqual([
    'tank/imp/disks/a@cp-moved1',
    'tank/imp/disks/a@cp-moved2',
  ]);

  expect(ctx.peer.fake.readMountedAt(join(ctx.peer.dataDir, 'imps', 'a', 'disk'))).toBe(
    'tank/imp/disks/a',
  );

  expect(ctx.peer.fake.listDatasets().filter((name) => name.includes('/staging/'))).toStrictEqual(
    [],
  );

  expect(ctx.fake.listSnapshots().filter((name) => name.includes('@mv-'))).toStrictEqual([]);
});

test('#openMoveSource plans a restored imp as its retired checkpoints and a clone of them', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');
  await ctx.backend.createCheckpoint('a', 'cp-two');
  await ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.resolve());
  await ctx.backend.createCheckpoint('a', 'cp-three');

  const source = await ctx.backend.openMoveSource('a', ['cp-one', 'cp-two', 'cp-three'], 'zfs');

  onTestFinished(() => source.close());

  if (source.kind !== 'zfs') {
    throw new Error('expected a ZFS move source');
  }

  expect(source.steps.map((step) => [step.checkpointId, step.dataset, step.base])).toStrictEqual([
    ['cp-one', 0, null],
    ['cp-two', 0, 0],
    ['cp-three', 1, 0],
    [null, 1, 2],
  ]);
});

test('#receiveMoveSnapshots lands a restored imp as a clone of its retired checkpoints', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');
  await ctx.backend.createCheckpoint('a', 'cp-two');
  await ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.resolve());
  await ctx.backend.createCheckpoint('a', 'cp-three');

  await ctx.peer.backend.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  const source = await ctx.backend.openMoveSource('a', ['cp-one', 'cp-two', 'cp-three'], 'zfs');

  onTestFinished(() => source.close());

  if (source.kind !== 'zfs') {
    throw new Error('expected a ZFS move source');
  }

  const ids = ['cp-moved1', 'cp-moved2', 'cp-moved3'];

  await ctx.peer.backend.receiveMoveSnapshots(
    'a',
    source.steps.map((step) => ({
      isCheckpoint: step.checkpointId !== null,
      dataset: step.dataset,
      base: step.base,
    })),
    (index) => source.steps[index]?.open().stdout ?? new ReadableStream(),
    () => ids.shift() ?? 'cp-none',
  );

  const retired = ctx.peer.fake.listDatasets().find((name) => name.startsWith('tank/imp/retired/'));

  invariant(retired);

  expect(ctx.peer.fake.readOrigin('tank/imp/disks/a')).toBe(`${retired}@cp-moved1`);

  expect(ctx.peer.fake.listSnapshots().filter((name) => name.startsWith(retired))).toStrictEqual([
    `${retired}@cp-moved1`,
    `${retired}@cp-moved2`,
  ]);
});

test('#receiveMoveSnapshots keeps the received disk snapshot through a GC before the rename', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');

  await ctx.peer.backend.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  const source = await ctx.backend.openMoveSource('a', ['cp-one'], 'zfs');

  onTestFinished(() => source.close());

  if (source.kind !== 'zfs') {
    throw new Error('expected a ZFS move source');
  }

  const steps = source.steps;
  const dropped: unknown[] = [];

  // the last stream stays open after `zfs recv` committed it, while a GC runs
  const received = await ctx.peer.backend.receiveMoveSnapshots(
    'a',
    steps.map((step) => ({
      isCheckpoint: step.checkpointId !== null,
      dataset: step.dataset,
      base: step.base,
    })),
    (index) => {
      const reader = steps[index]?.open().stdout.getReader();

      return new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          const read = await reader?.read();

          if (read?.done !== false) {
            const swept =
              index === steps.length - 1
                ? await ctx.peer.backend.dropUnnamed(
                    { impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() },
                    { isDryRun: false, isOrphans: false },
                  )
                : { dropped: 'not swept' };

            dropped.push(swept.dropped);
            controller.close();

            return;
          }

          controller.enqueue(read.value);
        },
      });
    },
    () => 'cp-moved1',
  );

  expect(dropped).toStrictEqual(['not swept', []]);
  expect(received.map((checkpoint) => checkpoint.id)).toStrictEqual(['cp-moved1']);

  expect(ctx.peer.fake.readMountedAt(join(ctx.peer.dataDir, 'imps', 'a', 'disk'))).toBe(
    'tank/imp/disks/a',
  );

  expect(ctx.peer.fake.listSnapshots().filter((name) => name.includes('@mv-'))).toStrictEqual([]);
});

test('#openMoveSource starts a forked disk with a full stream that carries nothing of the other imp', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');
  await ctx.backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-one' });

  const source = await ctx.backend.openMoveSource('b', [], 'zfs');

  onTestFinished(() => source.close());

  if (source.kind !== 'zfs') {
    throw new Error('expected a ZFS move source');
  }

  expect(source.steps.map((step) => [step.checkpointId, step.dataset, step.base])).toStrictEqual([
    [null, 0, null],
  ]);
});

test('#receiveMoveSnapshots leaves nothing in staging and no disk when a stream breaks', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');

  await ctx.peer.backend.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  const source = await ctx.backend.openMoveSource('a', ['cp-one'], 'zfs');

  onTestFinished(() => source.close());

  if (source.kind !== 'zfs') {
    throw new Error('expected a ZFS move source');
  }

  const steps = source.steps;

  expect(
    ctx.peer.backend.receiveMoveSnapshots(
      'a',
      steps.map((step) => ({
        isCheckpoint: step.checkpointId !== null,
        dataset: step.dataset,
        base: step.base,
      })),
      (index) =>
        index === 0
          ? (steps[0]?.open().stdout ?? new ReadableStream())
          : new ReadableStream({
              pull: (controller) => {
                controller.error(new Error('the stream broke'));
              },
            }),
      () => 'cp-new',
    ),
  ).rejects.toThrowWithMessage(Error, 'the stream broke');

  expect(
    ctx.peer.fake
      .listDatasets()
      .filter((name) => name.includes('/staging/') || name.includes('/disks/')),
  ).toStrictEqual([]);
});

test('#receiveMoveSnapshots leaves nothing in the way of a retry when a first stream fails after its end record', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');

  await ctx.peer.backend.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  const source = await ctx.backend.openMoveSource('a', ['cp-one'], 'zfs');

  onTestFinished(() => source.close());

  if (source.kind !== 'zfs') {
    throw new Error('expected a ZFS move source');
  }

  const steps = source.steps;

  const receiveSteps = steps.map((step) => ({
    isCheckpoint: step.checkpointId !== null,
    dataset: step.dataset,
    base: step.base,
  }));

  // the whole stream, so `zfs recv` commits it, then an error
  expect(
    ctx.peer.backend.receiveMoveSnapshots(
      'a',
      receiveSteps,
      (index) => {
        const reader = (steps[index]?.open().stdout ?? new ReadableStream()).getReader();

        return new ReadableStream({
          pull: async (controller) => {
            const next = await reader.read();

            if (next.done) {
              controller.error(new Error('the sum does not match'));
            } else {
              controller.enqueue(next.value);
            }
          },
        });
      },
      () => 'cp-new',
    ),
  ).rejects.toThrowWithMessage(Error, 'the sum does not match');

  const stagedAfterFailure = ctx.peer.fake
    .listDatasets()
    .filter((name) => name.includes('/staging/'));

  const retried = await ctx.peer.backend.receiveMoveSnapshots(
    'a',
    receiveSteps,
    (index) => steps[index]?.open().stdout ?? new ReadableStream(),
    () => 'cp-new',
  );

  expect(stagedAfterFailure).toStrictEqual([]);
  expect(retried.map((checkpoint) => checkpoint.id)).toStrictEqual(['cp-new']);
});

test('#receiveMoveSnapshots destroys each clone before its origin, whatever the plan numbers them', async () => {
  const ctx = setupTest();

  await ctx.peer.backend.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  // dataset 1 comes first and dataset 0 is its clone, as a peer may number
  // them; each stream is whole, so `zfs recv` commits it, and the second then
  // fails
  const streams = [
    { guid: 'g-one', baseGuid: null },
    { guid: 'g-two', baseGuid: 'g-one' },
  ];

  expect(
    ctx.peer.backend.receiveMoveSnapshots(
      'a',
      [
        { isCheckpoint: true, dataset: 1, base: null },
        { isCheckpoint: false, dataset: 0, base: 0 },
      ],
      (index) => {
        const whole = new TextEncoder().encode(JSON.stringify(streams[index]));

        const sent = { isWhole: false };

        return new ReadableStream({
          pull: (controller) => {
            if (!sent.isWhole) {
              sent.isWhole = true;

              controller.enqueue(whole);
            } else if (index === 1) {
              controller.error(new Error('the sum does not match'));
            } else {
              controller.close();
            }
          },
        });
      },
      () => 'cp-new',
    ),
  ).rejects.toThrowWithMessage(Error, 'the sum does not match');

  expect(ctx.peer.fake.listDatasets().filter((name) => name.includes('/staging/'))).toStrictEqual(
    [],
  );
});

test('#receiveMoveSnapshots refuses a peer plan that does not follow on before any receive', async () => {
  const ctx = setupTest();

  await ctx.peer.backend.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  expect(
    ctx.peer.backend.receiveMoveSnapshots(
      'a',
      [
        { isCheckpoint: true, dataset: 0, base: null },
        { isCheckpoint: false, dataset: 0, base: null },
      ],
      () => new ReadableStream(),
      () => 'cp-new',
    ),
  ).rejects.toThrowWithMessage(Error, 'zfs: step 1 of the move does not follow on');

  expect(ctx.peer.fake.commands.filter((command) => command.startsWith('zfs recv'))).toStrictEqual(
    [],
  );
});

test('#receiveMoveSnapshots refuses a move with no steps', async () => {
  const ctx = setupTest();

  await ctx.peer.backend.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  expect(
    ctx.peer.backend.receiveMoveSnapshots(
      'a',
      [],
      () => new ReadableStream(),
      () => 'cp-new',
    ),
  ).rejects.toThrowWithMessage(Error, 'zfs: a move with no steps');
});

test('#receiveMoveSnapshots refuses a move when every checkpoint id it picks is taken', async () => {
  const ctx = setupTest();

  await ctx.peer.backend.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  await ctx.peer.backend.createImpDisk('b', { kind: 'empty' });
  await ctx.peer.backend.createCheckpoint('b', 'cp-taken');

  expect(
    ctx.peer.backend.receiveMoveSnapshots(
      'a',
      [
        { isCheckpoint: true, dataset: 0, base: null },
        { isCheckpoint: false, dataset: 0, base: 0 },
      ],
      () => new ReadableStream(),
      () => 'cp-taken',
    ),
  ).rejects.toThrowWithMessage(CheckpointIdTakenError, 'a snapshot named cp-taken exists already');

  expect(ctx.peer.fake.commands.filter((command) => command.startsWith('zfs recv'))).toStrictEqual(
    [],
  );
});

test('#openMoveSource reads a move to XFS from read-only clones that a GC leaves while the move holds them', async () => {
  const ctx = setupTest();

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await ctx.backend.createImage('sha256:9f2c', () => Promise.resolve());
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:9f2c' });
  await ctx.backend.createCheckpoint('a', 'cp-one');

  const source = await ctx.backend.openMoveSource('a', ['cp-one'], 'files');

  // the test closes the source itself; the fallback closes it only once
  const closing = { done: null as Promise<void> | null };

  onTestFinished(() => (closing.done ??= source.close()));

  if (source.kind !== 'files') {
    throw new Error('expected a files move source');
  }

  const swept = await ctx.backend.dropUnnamed(
    {
      impIds: new Set(['a']),
      checkpointIds: new Set(['cp-one']),
      imageDigests: new Set(['sha256:9f2c']),
    },
    { isDryRun: false, isOrphans: true },
  );

  const isReadOnly = [...source.checkpointPaths, source.diskPath].map((path) =>
    ctx.fake.isReadOnlyAt(dirname(path)),
  );

  await (closing.done ??= source.close());

  expect(swept).toStrictEqual({ dropped: [], kept: [] });
  expect(isReadOnly).toStrictEqual([true, true]);
  expect(ctx.fake.listDatasets().filter((name) => name.includes('/staging/'))).toStrictEqual([]);
  expect(ctx.fake.listSnapshots().filter((name) => name.includes('@mv-'))).toStrictEqual([]);
});
