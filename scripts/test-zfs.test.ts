import { expect, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { createStubBin } from './test-utils/create-stub-bin';
import { createStubZfs } from './test-utils/create-stub-zfs';
import { createStubZpool } from './test-utils/create-stub-zpool';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-test-zfs-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // the script reads the loaded module's version before it does anything
  const moduleVersion = join(dir, 'zfs-version');

  writeFileSync(moduleVersion, '2.3.4-1\n');

  return {
    dir,
    moduleVersion,
    stubs: join(dir, 'stubs'),
    script: new URL('test-zfs.sh', import.meta.url).pathname,
  };
}

test('it creates the pool, runs the tests on it, then releases all it made', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs);

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');

  createStubBin(
    ctx.stubs,
    'bun',
    String.raw`printf "env %s %s\n" "$IMP_TEST_ZFS_ROOT" "$IMP_TEST_ZFS_DIR" >>"$STUB_CALLS"`,
  );

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/gu, 'imptestPID');

  expect(result.exitCode).toBe(0);

  expect(calls.split('\n')).toStrictEqual([
    'id -u',
    'zpool list imptestPID',
    'zfs version',
    `zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa imptestPID ${work}/pool.img`,
    'zfs create -o mountpoint=legacy imptestPID/imp',
    `mount -t zfs imptestPID/imp ${work}/mnt`,
    'bun test packages/daemon/src/storage/zfs',
    `env imptestPID/imp ${work}/mnt`,
    `umount -R ${work}/mnt`,
    'zpool list -H -o name',
    'zpool status -P imptestPID',
    'zpool destroy -f imptestPID',
    'zpool list -H -o name',
    'zpool status -P',
    '',
  ]);

  expect(existsSync(join(work, 'pool.img'))).toBeFalse();
  expect(existsSync(join(work, 'mnt'))).toBeFalse();
  expect(existsSync(work)).toBeTrue();
});

test('it removes a work dir it created itself', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');
  const zpool = createStubZpool(ctx.stubs);

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect(result.exitCode).toBe(0);
  expect(existsSync(work)).toBeFalse();
});

test('it refuses a pool name that is taken and touches nothing', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);

  const zpool = createStubBin(ctx.stubs, 'zpool');

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/gu, 'imptestPID');

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toMatch(
    /^test-zfs: a pool named imptest\d+ already exists; refusing to touch it\n$/u,
  );

  expect(calls).toBe('id -u\nzpool list imptestPID\n');
  expect(existsSync(join(work, 'pool.img'))).toBeFalse();
  expect(existsSync(join(work, 'mnt'))).toBeFalse();
});

test('it refuses a work dir that already holds a pool.img and leaves the file as it was', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  writeFileSync(join(work, 'pool.img'), 'another run');

  const zpool = createStubZpool(ctx.stubs);

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/gu, 'imptestPID');

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    `test-zfs: ${work}/pool.img already exists; refusing to touch it\n`,
  );

  expect(calls).toBe('id -u\nzpool list imptestPID\n');
  expect(readFileSync(join(work, 'pool.img'), 'utf8')).toBe('another run');
  expect(existsSync(join(work, 'mnt'))).toBeFalse();
});

test('it refuses a work dir that already holds a mnt and leaves it in place', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(join(work, 'mnt'), { recursive: true });
  writeFileSync(join(work, 'mnt', 'kept'), 'another run');

  const zpool = createStubZpool(ctx.stubs);

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/gu, 'imptestPID');

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    `test-zfs: ${work}/mnt already exists; refusing to touch it\n`,
  );

  expect(calls).toBe('id -u\nzpool list imptestPID\n');
  expect(readFileSync(join(work, 'mnt', 'kept'), 'utf8')).toBe('another run');
  expect(existsSync(join(work, 'pool.img'))).toBeFalse();
});

test('it destroys the pool it created and removes its file when the dataset cannot be made', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs);

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs, { create: 'fails' });
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/gu, 'imptestPID');

  expect(result.exitCode).toBe(1);

  expect(calls.split('\n')).toStrictEqual([
    'id -u',
    'zpool list imptestPID',
    'zfs version',
    `zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa imptestPID ${work}/pool.img`,
    'zfs create -o mountpoint=legacy imptestPID/imp',
    `umount -R ${work}/mnt`,
    'zpool list -H -o name',
    'zpool status -P imptestPID',
    'zpool destroy -f imptestPID',
    'zpool list -H -o name',
    'zpool status -P',
    '',
  ]);

  expect(existsSync(join(work, 'pool.img'))).toBeFalse();
  expect(existsSync(join(work, 'mnt'))).toBeFalse();
});

test('it never destroys a pool when its own create fails', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs, { create: 'fails' });

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/gu, 'imptestPID');

  expect(result.exitCode).toBe(1);

  expect(calls.split('\n')).toStrictEqual([
    'id -u',
    'zpool list imptestPID',
    'zfs version',
    `zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa imptestPID ${work}/pool.img`,
    `umount -R ${work}/mnt`,
    'zpool list -H -o name',
    'zpool list -H -o name',
    'zpool status -P',
    '',
  ]);

  expect(existsSync(join(work, 'pool.img'))).toBeFalse();
  expect(existsSync(join(work, 'mnt'))).toBeFalse();
});

test('it keeps the pool file and says so when the pool will not go', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs, { destroy: 'fails' });

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString().replaceAll(/imptest\d+/gu, 'imptestPID')).toBe(
    `test-zfs: could not destroy imptestPID; its file stays at ${work}/pool.img\n`,
  );

  expect(existsSync(join(work, 'pool.img'))).toBeTrue();
});

test('it refuses a pool.img that is a symlink and leaves the link and its target as they were', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');
  const target = join(ctx.dir, 'another-pool.img');

  mkdirSync(work);
  writeFileSync(target, 'another run');
  symlinkSync(target, join(work, 'pool.img'));

  const zpool = createStubZpool(ctx.stubs);

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    `test-zfs: ${work}/pool.img already exists; refusing to touch it\n`,
  );

  expect(readlinkSync(join(work, 'pool.img'))).toBe(target);
  expect(readFileSync(target, 'utf8')).toBe('another run');
  expect(existsSync(join(work, 'mnt'))).toBeFalse();
});

test('it stops the test run and releases all it made when it gets SIGTERM', async () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');
  const started = join(ctx.dir, 'tests-started');

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs);

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');

  // a test run that holds the pool until something stops it
  createStubBin(ctx.stubs, 'bun', `: >'${started}'; exec sleep 30`);

  const proc = Bun.spawn([ctx.script], {
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  onTestFinished(() => {
    proc.kill('SIGKILL');
  });

  await waitFor(() => readFileSync(started), { timeoutMs: 10_000 });

  proc.kill('SIGTERM');

  const exitCode = await proc.exited;

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/gu, 'imptestPID');

  expect(exitCode).toBe(143);

  expect(calls.split('\n').slice(-7)).toStrictEqual([
    `umount -R ${work}/mnt`,
    'zpool list -H -o name',
    'zpool status -P imptestPID',
    'zpool destroy -f imptestPID',
    'zpool list -H -o name',
    'zpool status -P',
    '',
  ]);

  expect(existsSync(join(work, 'pool.img'))).toBeFalse();
  expect(existsSync(join(work, 'mnt'))).toBeFalse();
});

test('it destroys the pool and removes its file when SIGTERM comes during the pool create', async () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');
  const startedMarker = join(ctx.dir, 'create-started');
  const release = join(ctx.dir, 'create-release');

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs, { create: { startedMarker, release } });

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const proc = Bun.spawn([ctx.script], {
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  onTestFinished(() => {
    proc.kill('SIGKILL');
  });

  await waitFor(() => readFileSync(startedMarker), { timeoutMs: 10_000 });

  // the create holds until the release, so the signal lands inside it
  proc.kill('SIGTERM');

  writeFileSync(release, '');

  const exitCode = await proc.exited;

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/gu, 'imptestPID');

  expect(exitCode).toBe(143);

  expect(calls.split('\n').slice(-7)).toStrictEqual([
    `umount -R ${work}/mnt`,
    'zpool list -H -o name',
    'zpool status -P imptestPID',
    'zpool destroy -f imptestPID',
    'zpool list -H -o name',
    'zpool status -P',
    '',
  ]);

  expect(readFileSync(join(ctx.stubs, 'pools'), 'utf8')).toBe('');
  expect(existsSync(join(work, 'pool.img'))).toBeFalse();
});

test('it keeps the pool file and fails while a pool still uses it', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs, { destroy: 'ignored' });

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe(`test-zfs: a pool still uses ${work}/pool.img; it stays\n`);
  expect(existsSync(join(work, 'pool.img'))).toBeTrue();
});

test('it removes its pool file while another pool uses a vdev path that only starts with it', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs);

  // another pool, whose vdev path is this run's pool.img with more after a space
  writeFileSync(join(ctx.stubs, 'pools'), `tank ${work}/pool.img old\n`);
  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    stderr: '',
  });

  expect(readFileSync(join(ctx.stubs, 'pools'), 'utf8')).toBe(`tank ${work}/pool.img old\n`);
  expect(existsSync(join(work, 'pool.img'))).toBeFalse();
});

test('it keeps the pool file and fails while another pool uses a vdev path equal to it', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs);

  writeFileSync(join(ctx.stubs, 'pools'), `tank ${work}/pool.img\n`);
  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe(`test-zfs: a pool still uses ${work}/pool.img; it stays\n`);
  expect(readFileSync(join(ctx.stubs, 'pools'), 'utf8')).toBe(`tank ${work}/pool.img\n`);
  expect(existsSync(join(work, 'pool.img'))).toBeTrue();
});

test('it makes a work dir that does not exist yet, parents included', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'not', 'yet', 'work');
  const zpool = createStubZpool(ctx.stubs);

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect(result.exitCode).toBe(0);
  expect(existsSync(work)).toBeFalse();
  expect(existsSync(join(ctx.dir, 'not', 'yet'))).toBeTrue();
});

test('it destroys its pool and removes the file when the work dir path holds spaces', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work dir');

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs);

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(ctx.stubs, 'pools'), 'utf8')).toBe('');
  expect(existsSync(join(work, 'pool.img'))).toBeFalse();
});

test('it destroys its pool and removes the file when the work dir path holds a state word', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work  ONLINE dir');

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs);

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(ctx.stubs, 'pools'), 'utf8')).toBe('');
  expect(existsSync(join(work, 'pool.img'))).toBeFalse();
});

test('it keeps the pool file and fails when zpool cannot say what uses it', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs, { queries: 'fail' });

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);
  createStubBin(ctx.stubs, 'mount');
  createStubBin(ctx.stubs, 'umount');
  createStubBin(ctx.stubs, 'bun');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    `test-zfs: zpool cannot say which pools use ${work}/pool.img; it stays\n`,
  );

  expect(existsSync(join(work, 'pool.img'))).toBeTrue();
});

test('it refuses to run as a user other than root and touches nothing', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');
  const zpool = createStubZpool(ctx.stubs);

  createStubBin(ctx.stubs, 'id', 'echo 1000');
  createStubZfs(ctx.stubs);

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: `test-zfs: run as root: sudo env "PATH=$PATH" ${ctx.script}\n`,
  });

  expect(readFileSync(zpool.calls, 'utf8')).toBe('id -u\n');
  expect(existsSync(work)).toBeFalse();
});

test('it refuses to run when the zfs module is not loaded and touches nothing', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');
  const zpool = createStubZpool(ctx.stubs);

  createStubBin(ctx.stubs, 'id', 'echo 0');
  createStubZfs(ctx.stubs);

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: `${zpool.bin}:${process.env['PATH'] ?? ''}`,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: join(ctx.dir, 'no-zfs-module', 'version'),
    },
  });

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'test-zfs: the zfs kernel module is not loaded (modprobe zfs)\n',
  });

  expect(readFileSync(zpool.calls, 'utf8')).toBe('id -u\n');
  expect(existsSync(work)).toBeFalse();
});

test('it refuses to run when zpool is missing and touches nothing', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');
  const id = createStubBin(ctx.stubs, 'id', 'echo 0');

  createStubZfs(ctx.stubs);

  // only the stubs, and no zpool among them
  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: id.bin,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_TEST_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'test-zfs: zpool is missing; install zfsutils-linux\n',
  });

  expect(readFileSync(id.calls, 'utf8')).toBe('id -u\n');
  expect(existsSync(work)).toBeFalse();
});
