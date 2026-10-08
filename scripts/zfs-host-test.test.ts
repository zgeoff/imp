import { expect, onTestFinished, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
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
import { createStubBin } from './test-utils/create-stub-bin';

// The script runs from a copy of the repo's scripts dir, beside the lib.sh it
// sources and stand-ins for the repo scripts it calls, which log to the same
// call log as the stub binaries on PATH.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-zfs-host-test-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const scripts = join(dir, 'root', 'scripts');

  mkdirSync(scripts, { recursive: true });

  for (const name of ['zfs-host-test.sh', 'lib.sh']) {
    copyFileSync(new URL(name, import.meta.url).pathname, join(scripts, name));
  }

  // sudo runs what it is given; the docker log is empty
  const stubs = join(dir, 'stubs');
  const sudo = createStubBin(stubs, 'sudo', 'exec "$@"');

  createStubBin(stubs, 'docker');
  createStubBin(stubs, 'zfs');

  for (const name of ['dev.sh', 'test-e2e.sh', 'test-zfs.sh']) {
    writeFileSync(
      join(scripts, name),
      `#!/bin/bash\nprintf '%s\\n' "${name} $*" >>'${sudo.calls}'\n`,
    );

    chmodSync(join(scripts, name), 0o755);
  }

  // the script reads the loaded module's version before it does anything
  const moduleVersion = join(dir, 'zfs-version');

  writeFileSync(moduleVersion, '2.3.4-1\n');

  return {
    dir,
    stubs,
    moduleVersion,
    calls: sudo.calls,
    path: `${sudo.bin}:${process.env['PATH'] ?? ''}`,
    script: join(scripts, 'zfs-host-test.sh'),
  };
}

test('it runs the unit tests and suites on a bench pool, then releases all it made', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubBin(ctx.stubs, 'zpool', 'if [ "$1" = list ]; then exit 1; fi');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: ctx.path,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_BENCH_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  const calls = readFileSync(ctx.calls, 'utf8')
    .replaceAll(/impbench\d+/g, 'impbenchPID')
    .replaceAll(/PATH=\S+/g, 'PATH=…');

  expect(result.exitCode).toBe(0);

  expect(calls.split('\n')).toStrictEqual([
    'sudo zpool list impbenchPID',
    'zpool list impbenchPID',
    `sudo env PATH=… IMP_ZFS_TEST_DIR=${work}/unit ${ctx.dir}/root/scripts/test-zfs.sh`,
    'test-zfs.sh ',
    `sudo zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa impbenchPID ${work}/bench.img`,
    `zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa impbenchPID ${work}/bench.img`,
    'sudo zfs create -o mountpoint=legacy impbenchPID/imp',
    'zfs create -o mountpoint=legacy impbenchPID/imp',
    'test-e2e.sh --only checkpoints,sleep',
    'docker logs imp-zfs',
    'sudo zfs list -r -o name,used,refer,compressratio,recordsize impbenchPID',
    'zfs list -r -o name,used,refer,compressratio,recordsize impbenchPID',
    'docker logs imp-zfs',
    'dev.sh down',
    'sudo zpool destroy -f impbenchPID',
    'zpool destroy -f impbenchPID',
    `sudo rm -f ${work}/bench.img`,
    '',
  ]);

  expect(existsSync(join(work, 'bench.img'))).toBeFalse();
  expect(existsSync(join(work, 'summary.txt'))).toBeTrue();
});

test('it refuses a bench pool name that is taken and touches nothing', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubBin(ctx.stubs, 'zpool');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: ctx.path,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_BENCH_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  const calls = readFileSync(ctx.calls, 'utf8').replaceAll(/impbench\d+/g, 'impbenchPID');

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toMatch(
    /^zfs-host-test: a pool named impbench\d+ already exists; refusing to touch it\n$/,
  );

  expect(calls).toBe('sudo zpool list impbenchPID\nzpool list impbenchPID\n');
  expect(existsSync(join(work, 'bench.img'))).toBeFalse();
});

test('it refuses a work dir that already holds a bench.img and leaves the file as it was', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  writeFileSync(join(work, 'bench.img'), 'another run');
  createStubBin(ctx.stubs, 'zpool', 'if [ "$1" = list ]; then exit 1; fi');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: ctx.path,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_BENCH_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  const calls = readFileSync(ctx.calls, 'utf8').replaceAll(/impbench\d+/g, 'impbenchPID');

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    `zfs-host-test: ${work}/bench.img already exists; refusing to touch it\n`,
  );

  expect(calls).toBe('sudo zpool list impbenchPID\nzpool list impbenchPID\n');
  expect(readFileSync(join(work, 'bench.img'), 'utf8')).toBe('another run');
});

test('it refuses a bench.img that is a symlink and leaves the link and its target as they were', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');
  const target = join(ctx.dir, 'another-bench.img');

  mkdirSync(work);
  writeFileSync(target, 'another run');
  symlinkSync(target, join(work, 'bench.img'));
  createStubBin(ctx.stubs, 'zpool', 'if [ "$1" = list ]; then exit 1; fi');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: ctx.path,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_BENCH_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    `zfs-host-test: ${work}/bench.img already exists; refusing to touch it\n`,
  );

  expect(readlinkSync(join(work, 'bench.img'))).toBe(target);
  expect(readFileSync(target, 'utf8')).toBe('another run');
});

test('it never destroys a pool or stops an instance when its own pool create fails', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);

  createStubBin(
    ctx.stubs,
    'zpool',
    'case "$1" in list) exit 1 ;; create) echo "pool already exists" >&2; exit 1 ;; esac',
  );

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: ctx.path,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_BENCH_GIB: '1',
      IMP_ZFS_TEST_UNIT: '0',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  const calls = readFileSync(ctx.calls, 'utf8').replaceAll(/impbench\d+/g, 'impbenchPID');

  expect(result.exitCode).toBe(1);

  expect(calls.split('\n')).toStrictEqual([
    'sudo zpool list impbenchPID',
    'zpool list impbenchPID',
    `sudo zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa impbenchPID ${work}/bench.img`,
    `zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa impbenchPID ${work}/bench.img`,
    `sudo rm -f ${work}/bench.img`,
    '',
  ]);

  expect(existsSync(join(work, 'bench.img'))).toBeFalse();
});

test('it fails and keeps the pool file, saying so, when the pool will not go', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubBin(ctx.stubs, 'zpool', 'case "$1" in list | destroy) exit 1 ;; esac');

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: ctx.path,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_BENCH_GIB: '1',
      IMP_ZFS_TEST_UNIT: '0',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString().replaceAll(/impbench\d+/g, 'impbenchPID')).toBe(
    `zfs-host-test: could not destroy impbenchPID; its file stays at ${work}/bench.img\n`,
  );

  expect(existsSync(join(work, 'bench.img'))).toBeTrue();
});
