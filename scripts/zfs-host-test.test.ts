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
import { waitFor } from '@imp/test-utils/wait-for';
import { createStubBin } from './test-utils/create-stub-bin';
import { createStubZpool } from './test-utils/create-stub-zpool';

// a repo script that logs its call, then runs body
function writeStandIn(scripts: string, name: string, calls: string, body = ''): void {
  writeFileSync(
    join(scripts, name),
    `#!/bin/bash\nprintf '%s\\n' "${name} $*" >>'${calls}'\n${body}\n`,
  );

  chmodSync(join(scripts, name), 0o755);
}

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

  // sudo runs what it is given; no container is there, and the docker log
  // is empty
  const stubs = join(dir, 'stubs');
  const sudo = createStubBin(stubs, 'sudo', 'exec "$@"');

  createStubBin(stubs, 'docker', 'if [ "$1" = container ]; then exit 1; fi');
  createStubBin(stubs, 'zfs');

  for (const name of ['dev.sh', 'test-e2e.sh', 'test-zfs.sh']) {
    writeStandIn(scripts, name, sudo.calls);
  }

  // the script reads the loaded module's version before it does anything
  const moduleVersion = join(dir, 'zfs-version');

  writeFileSync(moduleVersion, '2.3.4-1\n');

  return {
    dir,
    stubs,
    scripts,
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
  createStubZpool(ctx.stubs);

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
    'docker container inspect imp-zfs',
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
    'sudo zpool list -H -o name',
    'zpool list -H -o name',
    'sudo zpool status -P impbenchPID',
    'zpool status -P impbenchPID',
    'sudo zpool destroy -f impbenchPID',
    'zpool destroy -f impbenchPID',
    'sudo zpool list -H -o name',
    'zpool list -H -o name',
    'sudo zpool status -P',
    'zpool status -P',
    `sudo rm -f ${work}/bench.img`,
    '',
  ]);

  expect(existsSync(join(work, 'bench.img'))).toBeFalse();
  expect(existsSync(join(work, 'summary.txt'))).toBeTrue();

  const owner = readFileSync(join(work, 'data', 'imp-e2e-zfs-owner'), 'utf8').replaceAll(
    /impbench\d+/g,
    'impbenchPID',
  );

  expect(owner).toBe(
    `{"pool":"impbenchPID","root":"impbenchPID/imp","vdev":"${work}/bench.img"}\n`,
  );
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
  createStubZpool(ctx.stubs);

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
  createStubZpool(ctx.stubs);

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
  createStubZpool(ctx.stubs, { create: 'fails' });

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
    'docker container inspect imp-zfs',
    `sudo zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa impbenchPID ${work}/bench.img`,
    `zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa impbenchPID ${work}/bench.img`,
    'sudo zpool list -H -o name',
    'zpool list -H -o name',
    'sudo zpool list -H -o name',
    'zpool list -H -o name',
    'sudo zpool status -P',
    'zpool status -P',
    `sudo rm -f ${work}/bench.img`,
    '',
  ]);

  expect(existsSync(join(work, 'bench.img'))).toBeFalse();
});

test('it fails and keeps the pool file, saying so, when the pool will not go', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs, { destroy: 'fails' });

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

test('it refuses a work dir that already holds a data dir and leaves it as it was', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(join(work, 'data'), { recursive: true });
  writeFileSync(join(work, 'data', 'imp.db'), 'another run');
  createStubZpool(ctx.stubs);

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
    `zfs-host-test: ${work}/data already exists; refusing to touch it\n`,
  );

  expect(calls).toBe('sudo zpool list impbenchPID\nzpool list impbenchPID\n');
  expect(readFileSync(join(work, 'data', 'imp.db'), 'utf8')).toBe('another run');
});

test('it refuses an imp-zfs container that is already there and touches nothing', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs);

  // another run's instance answers inspect
  createStubBin(ctx.stubs, 'docker');

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
    'zfs-host-test: a container named imp-zfs already exists; refusing to touch it\n',
  );

  expect(calls).toBe(
    'sudo zpool list impbenchPID\nzpool list impbenchPID\ndocker container inspect imp-zfs\n',
  );

  expect(existsSync(join(work, 'data'))).toBeFalse();
});

test('it makes a work dir that does not exist yet, parents included', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'not', 'yet', 'work');

  createStubZpool(ctx.stubs);

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: ctx.path,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_BENCH_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect(result.exitCode).toBe(0);
  expect(existsSync(join(work, 'summary.txt'))).toBeTrue();
});

test('it stops the suites, the instance and the pool when it gets SIGTERM during the run', async () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');
  const started = join(ctx.dir, 'suites-started');

  mkdirSync(work);
  createStubZpool(ctx.stubs);

  // a run that holds the instance until something stops it
  writeStandIn(ctx.scripts, 'test-e2e.sh', ctx.calls, `: >'${started}'; exec sleep 30`);

  const proc = Bun.spawn([ctx.script], {
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      PATH: ctx.path,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_BENCH_GIB: '1',
      IMP_ZFS_TEST_UNIT: '0',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  onTestFinished(() => {
    proc.kill('SIGKILL');
  });

  await waitFor(() => readFileSync(started), { timeoutMs: 10_000 });

  proc.kill('SIGTERM');

  const exitCode = await proc.exited;

  const calls = readFileSync(ctx.calls, 'utf8').replaceAll(/impbench\d+/g, 'impbenchPID');

  expect(exitCode).toBe(143);

  expect(calls.split('\n').slice(-15)).toStrictEqual([
    'test-e2e.sh --only checkpoints,sleep',
    'docker logs imp-zfs',
    'dev.sh down',
    'sudo zpool list -H -o name',
    'zpool list -H -o name',
    'sudo zpool status -P impbenchPID',
    'zpool status -P impbenchPID',
    'sudo zpool destroy -f impbenchPID',
    'zpool destroy -f impbenchPID',
    'sudo zpool list -H -o name',
    'zpool list -H -o name',
    'sudo zpool status -P',
    'zpool status -P',
    `sudo rm -f ${work}/bench.img`,
    '',
  ]);

  expect(existsSync(join(work, 'bench.img'))).toBeFalse();
});

test('it destroys the pool and removes its file when SIGTERM comes during the pool create', async () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');
  const startedMarker = join(ctx.dir, 'create-started');

  mkdirSync(work);
  createStubZpool(ctx.stubs, { create: { startedMarker } });

  const proc = Bun.spawn([ctx.script], {
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      PATH: ctx.path,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_BENCH_GIB: '1',
      IMP_ZFS_TEST_UNIT: '0',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  onTestFinished(() => {
    proc.kill('SIGKILL');
  });

  await waitFor(() => readFileSync(startedMarker), { timeoutMs: 10_000 });

  proc.kill('SIGTERM');

  const exitCode = await proc.exited;

  const calls = readFileSync(ctx.calls, 'utf8').replaceAll(/impbench\d+/g, 'impbenchPID');

  expect(exitCode).toBe(143);

  expect(calls.split('\n').slice(-12)).toStrictEqual([
    'sudo zpool list -H -o name',
    'zpool list -H -o name',
    'sudo zpool status -P impbenchPID',
    'zpool status -P impbenchPID',
    'sudo zpool destroy -f impbenchPID',
    'zpool destroy -f impbenchPID',
    'sudo zpool list -H -o name',
    'zpool list -H -o name',
    'sudo zpool status -P',
    'zpool status -P',
    `sudo rm -f ${work}/bench.img`,
    '',
  ]);

  expect(readFileSync(join(ctx.stubs, 'pools'), 'utf8')).toBe('');
  expect(existsSync(join(work, 'bench.img'))).toBeFalse();
});

test('it keeps the pool file and fails while a pool still uses it', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs, { destroy: 'ignored' });

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

  expect(result.stderr.toString()).toBe(
    `zfs-host-test: a pool still uses ${work}/bench.img; it stays\n`,
  );

  expect(existsSync(join(work, 'bench.img'))).toBeTrue();
});

test('it destroys its pool and removes the file when the work dir path holds spaces', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work dir');

  mkdirSync(work);
  createStubZpool(ctx.stubs);

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: ctx.path,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_BENCH_GIB: '1',
      IMP_ZFS_TEST_UNIT: '0',
      IMP_ZFS_MODULE_VERSION_FILE: ctx.moduleVersion,
    },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(ctx.stubs, 'pools'), 'utf8')).toBe('');
  expect(existsSync(join(work, 'bench.img'))).toBeFalse();
});

test('it keeps the pool file and fails when zpool cannot say what uses it', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs, { queries: 'fail' });

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

  expect(result.stderr.toString()).toBe(
    `zfs-host-test: zpool cannot say which pools use ${work}/bench.img; it stays\n`,
  );

  expect(existsSync(join(work, 'bench.img'))).toBeTrue();
});
