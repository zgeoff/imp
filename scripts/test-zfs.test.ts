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
import { waitFor } from '@imp/test-utils/wait-for';
import { createStubBin } from './test-utils/create-stub-bin';
import { createStubZpool } from './test-utils/create-stub-zpool';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-test-zfs-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // the script reads the loaded module's version before it does anything
  const moduleVersion = join(dir, 'zfs-version');

  writeFileSync(moduleVersion, '2.3.4-1\n');

  // the run's root check, and the userland version line it prints
  const stubs = join(dir, 'stubs');

  createStubBin(stubs, 'id', 'echo 0');
  createStubBin(stubs, 'zfs', 'if [ "$1" = version ]; then echo zfs-2.3.4-1; fi');

  return {
    dir,
    moduleVersion,
    stubs,
    script: new URL('test-zfs.sh', import.meta.url).pathname,
  };
}

test('it creates the pool, runs the tests on it, then releases all it made', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs);

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

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/g, 'imptestPID');

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

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/g, 'imptestPID');

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toMatch(
    /^test-zfs: a pool named imptest\d+ already exists; refusing to touch it\n$/,
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

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/g, 'imptestPID');

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

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/g, 'imptestPID');

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

  createStubBin(
    ctx.stubs,
    'zfs',
    'case "$1" in version) echo zfs-2.3.4-1 ;; create) exit 1 ;; esac',
  );

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

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/g, 'imptestPID');

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

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/g, 'imptestPID');

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

  expect(result.stderr.toString().replaceAll(/imptest\d+/g, 'imptestPID')).toBe(
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

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/g, 'imptestPID');

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

  mkdirSync(work);

  const zpool = createStubZpool(ctx.stubs, { create: { startedMarker } });

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

  proc.kill('SIGTERM');

  const exitCode = await proc.exited;

  const calls = readFileSync(zpool.calls, 'utf8').replaceAll(/imptest\d+/g, 'imptestPID');

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

test('it makes a work dir that does not exist yet, parents included', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'not', 'yet', 'work');
  const zpool = createStubZpool(ctx.stubs);

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
