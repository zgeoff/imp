import { expect, onTestFinished, test } from 'bun:test';
import {
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
import { createStubInstanceDocker } from './test-utils/create-stub-instance-docker';
import { createStubRepoScript } from './test-utils/create-stub-repo-script';
import { createStubZfs } from './test-utils/create-stub-zfs';
import { createStubZpool } from './test-utils/create-stub-zpool';

// The script runs from a copy of the repo's scripts dir, beside the lib.sh it
// sources and stand-ins for the repo scripts it calls, which log to the same
// call log as the stub binaries on PATH.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-zfs-host-test-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const scripts = join(dir, 'root', 'scripts');
  const tests = join(dir, 'root', 'test');

  mkdirSync(join(scripts, 'dev'), { recursive: true });
  mkdirSync(tests);

  for (const name of ['zfs-host-test.sh', 'lib.sh']) {
    copyFileSync(new URL(name, import.meta.url).pathname, join(scripts, name));
  }

  // sudo runs what it is given
  const stubs = join(dir, 'stubs');
  const sudo = createStubBin(stubs, 'sudo', 'exec "$@"');

  createStubZfs(stubs);
  createStubRepoScript(join(scripts, 'dev'), 'dev.sh', sudo.calls);
  createStubRepoScript(tests, 'test-e2e.sh', sudo.calls);
  createStubRepoScript(scripts, 'test-zfs.sh', sudo.calls);

  // the script reads the loaded module's version before it does anything
  const moduleVersion = join(dir, 'zfs-version');

  writeFileSync(moduleVersion, '2.3.4-1\n');

  return {
    dir,
    stubs,
    tests,
    moduleVersion,
    calls: sudo.calls,
    path: `${sudo.bin}:${process.env['PATH'] ?? ''}`,
    script: join(scripts, 'zfs-host-test.sh'),
  };
}

test('it runs the unit tests and suites on a bench pool, then releases all it made', () => {
  const ctx = setupTest();

  createStubInstanceDocker(ctx.stubs, { containers: [] });

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

  const calls = readFileSync(ctx.calls, 'utf8').replaceAll(/impbench\d+/g, 'impbenchPID');

  expect(result.exitCode).toBe(0);

  expect(calls.split('\n')).toStrictEqual([
    'sudo zpool list impbenchPID',
    'zpool list impbenchPID',
    'docker container inspect imp-zfs',
    'docker container inspect imp-zfs-mv-b',
    'docker network inspect imp-zfs-mv',
    `sudo env PATH=${ctx.path} IMP_ZFS_TEST_DIR=${work}/unit ${ctx.dir}/root/scripts/test-zfs.sh`,
    'test-zfs.sh ',
    `sudo zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa impbenchPID ${work}/bench.img`,
    `zpool create -O mountpoint=none -O compression=lz4 -O atime=off -O xattr=sa impbenchPID ${work}/bench.img`,
    'sudo zfs create -o mountpoint=legacy impbenchPID/imp',
    'zfs create -o mountpoint=legacy impbenchPID/imp',
    'sudo zfs create -o mountpoint=legacy impbenchPID/imp-mv-b',
    'zfs create -o mountpoint=legacy impbenchPID/imp-mv-b',
    'test-e2e.sh --only checkpoints,sleep',
    'docker logs imp-zfs',
    'sudo zfs list -r -o name,used,refer,compressratio,recordsize impbenchPID',
    'zfs list -r -o name,used,refer,compressratio,recordsize impbenchPID',
    'docker container inspect imp-zfs-mv-b',
    'docker logs imp-zfs',
    'dev.sh down',
    'docker network rm imp-zfs-mv',
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

  const ownerB = readFileSync(join(work, 'data-mv-b', 'imp-e2e-zfs-owner'), 'utf8').replaceAll(
    /impbench\d+/g,
    'impbenchPID',
  );

  expect(ownerB).toBe(
    `{"pool":"impbenchPID","root":"impbenchPID/imp-mv-b","vdev":"${work}/bench.img"}\n`,
  );
});

test('it refuses a bench pool name that is taken and touches nothing', () => {
  const ctx = setupTest();

  createStubInstanceDocker(ctx.stubs, { containers: [] });

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

  createStubInstanceDocker(ctx.stubs, { containers: [] });

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

  createStubInstanceDocker(ctx.stubs, { containers: [] });

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

  createStubInstanceDocker(ctx.stubs, { containers: [] });

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
    'docker container inspect imp-zfs-mv-b',
    'docker network inspect imp-zfs-mv',
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

  createStubInstanceDocker(ctx.stubs, { containers: [] });

  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs, { destroy: 'fails' });
  createStubBin(ctx.stubs, 'dmesg', 'echo "[  12.000000] eth0: link up"');

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

test('it keeps the pool file, prints the oops and passes when a kernel oops in ZFS holds the pool', () => {
  const ctx = setupTest();

  createStubInstanceDocker(ctx.stubs, { containers: [] });

  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs, { destroy: 'busy' });

  createStubBin(
    ctx.stubs,
    'dmesg',
    `cat <<'EOF'
[  80.100000] eth0: link up
[  90.200000] usercopy: Kernel memory exposure attempt detected from SLUB object 'zio_buf_comb_16384' (offset 12288, size 20480)!
[  90.200050] ------------[ cut here ]------------
[  90.200100] kernel BUG at mm/usercopy.c:102!
[  90.200200] Oops: invalid opcode: 0000 [#1] SMP NOPTI
[  90.200300] CPU: 0 UID: 900000 PID: 4242 Comm: firecracker Tainted: P O 6.17.0-1-azure
[  90.200400] RIP: 0010:usercopy_abort+0x6c/0x80
[  90.200500]  zfs_uiomove_iter+0x47/0xc0 [zfs]
[  90.200600]  zfs_read+0x3c8/0x500 [zfs]
[  90.200700]  vfs_read+0x24d/0x370
[  90.200800] ---[ end trace 0000000000000000 ]---
[  90.200900] RIP: 0010:usercopy_abort+0x6c/0x80
EOF`,
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

  const calls = readFileSync(ctx.calls, 'utf8');

  expect(result.exitCode).toBe(0);

  expect(result.stderr.toString().replaceAll(/impbench\d+/g, 'impbenchPID')).toBe(
    `cannot destroy 'impbenchPID': pool is busy
zfs-host-test: a kernel oops in ZFS holds impbenchPID until a reboot; its file stays at ${work}/bench.img
[  90.200000] usercopy: Kernel memory exposure attempt detected from SLUB object 'zio_buf_comb_16384' (offset 12288, size 20480)!
[  90.200100] kernel BUG at mm/usercopy.c:102!
[  90.200200] Oops: invalid opcode: 0000 [#1] SMP NOPTI
[  90.200300] CPU: 0 UID: 900000 PID: 4242 Comm: firecracker Tainted: P O 6.17.0-1-azure
[  90.200500]  zfs_uiomove_iter+0x47/0xc0 [zfs]
[  90.200600]  zfs_read+0x3c8/0x500 [zfs]
`,
  );

  expect(calls).toMatch(/^dmesg --since \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m);
  expect(existsSync(join(work, 'bench.img'))).toBeTrue();
});

test('it fails and keeps the pool file when an oops outside ZFS sits beside a ZFS warning', () => {
  const ctx = setupTest();

  createStubInstanceDocker(ctx.stubs, { containers: [] });

  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs, { destroy: 'busy' });

  createStubBin(
    ctx.stubs,
    'dmesg',
    `cat <<'EOF'
[  90.200050] ------------[ cut here ]------------
[  90.200100] kernel BUG at mm/slub.c:500!
[  90.200200] Oops: invalid opcode: 0000 [#1] SMP NOPTI
[  90.200500]  kmem_cache_free+0x10/0x40
[  90.200600] ---[ end trace 0000000000000000 ]---
[  95.300000] ------------[ cut here ]------------
[  95.300100] WARNING: CPU: 1 PID: 77 at module/zfs/txg.c:600 txg_wait_synced+0x20/0x40 [zfs]
[  95.300200]  txg_wait_synced+0x20/0x40 [zfs]
[  95.300300] ---[ end trace 0000000000000000 ]---
EOF`,
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

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString().replaceAll(/impbench\d+/g, 'impbenchPID')).toBe(
    `cannot destroy 'impbenchPID': pool is busy
zfs-host-test: could not destroy impbenchPID; its file stays at ${work}/bench.img
`,
  );

  expect(existsSync(join(work, 'bench.img'))).toBeTrue();
});

test('it fails and keeps the pool file when a ZFS soft lockup comes before an oops outside ZFS', () => {
  const ctx = setupTest();

  createStubInstanceDocker(ctx.stubs, { containers: [] });

  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs, { destroy: 'busy' });

  createStubBin(
    ctx.stubs,
    'dmesg',
    `cat <<'EOF'
[  80.100000] watchdog: BUG: soft lockup - CPU#2 stuck for 26s! [z_wr_iss:812]
[  80.100100] CPU: 2 UID: 0 PID: 812 Comm: z_wr_iss Tainted: P O 6.17.0-1-azure
[  80.100200]  zio_execute+0x90/0x130 [zfs]
[  80.100300]  taskq_thread+0x2a0/0x4d0 [spl]
[  90.200050] ------------[ cut here ]------------
[  90.200100] kernel BUG at mm/slub.c:500!
[  90.200200] Oops: invalid opcode: 0000 [#1] SMP NOPTI
[  90.200500]  kmem_cache_free+0x10/0x40
[  90.200600] ---[ end trace 0000000000000000 ]---
EOF`,
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

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString().replaceAll(/impbench\d+/g, 'impbenchPID')).toBe(
    `cannot destroy 'impbenchPID': pool is busy
zfs-host-test: could not destroy impbenchPID; its file stays at ${work}/bench.img
`,
  );

  expect(existsSync(join(work, 'bench.img'))).toBeTrue();
});

test('it keeps the pool file and passes when a page-fault oops in ZFS holds the pool', () => {
  const ctx = setupTest();

  createStubInstanceDocker(ctx.stubs, { containers: [] });

  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs, { destroy: 'busy' });

  createStubBin(
    ctx.stubs,
    'dmesg',
    `cat <<'EOF'
[  90.200000] BUG: unable to handle page fault for address: ffffa0b1c0000000
[  90.200100] #PF: supervisor read access in kernel mode
[  90.200200] Oops: 0000 [#1] SMP NOPTI
[  90.200300] CPU: 1 UID: 900000 PID: 4343 Comm: firecracker Tainted: P O 6.17.0-1-azure
[  90.200400]  zfs_read+0x3c8/0x500 [zfs]
[  90.200500] ---[ end trace 0000000000000000 ]---
EOF`,
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

  expect(result.exitCode).toBe(0);

  expect(result.stderr.toString().replaceAll(/impbench\d+/g, 'impbenchPID')).toBe(
    `cannot destroy 'impbenchPID': pool is busy
zfs-host-test: a kernel oops in ZFS holds impbenchPID until a reboot; its file stays at ${work}/bench.img
[  90.200200] Oops: 0000 [#1] SMP NOPTI
[  90.200300] CPU: 1 UID: 900000 PID: 4343 Comm: firecracker Tainted: P O 6.17.0-1-azure
[  90.200400]  zfs_read+0x3c8/0x500 [zfs]
`,
  );

  expect(existsSync(join(work, 'bench.img'))).toBeTrue();
});

test('it fails and keeps the pool file when a destroy fails for a reason other than a busy pool after a ZFS oops', () => {
  const ctx = setupTest();

  createStubInstanceDocker(ctx.stubs, { containers: [] });

  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs, { destroy: 'fails' });

  createStubBin(
    ctx.stubs,
    'dmesg',
    `cat <<'EOF'
[  90.200100] kernel BUG at mm/usercopy.c:102!
[  90.200200] Oops: invalid opcode: 0000 [#1] SMP NOPTI
[  90.200500]  zfs_uiomove_iter+0x47/0xc0 [zfs]
[  90.200600] ---[ end trace 0000000000000000 ]---
EOF`,
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

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString().replaceAll(/impbench\d+/g, 'impbenchPID')).toBe(
    `zfs-host-test: could not destroy impbenchPID; its file stays at ${work}/bench.img\n`,
  );

  expect(existsSync(join(work, 'bench.img'))).toBeTrue();
});

test('it refuses a work dir that already holds a data dir and leaves it as it was', () => {
  const ctx = setupTest();

  createStubInstanceDocker(ctx.stubs, { containers: [] });

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
  createStubInstanceDocker(ctx.stubs, { containers: ['imp-zfs'] });

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

test('it refuses a work dir that already holds the moves suites’ B data dir and leaves it as it was', () => {
  const ctx = setupTest();

  createStubInstanceDocker(ctx.stubs, { containers: [] });

  const work = join(ctx.dir, 'work');

  mkdirSync(join(work, 'data-mv-b'), { recursive: true });
  writeFileSync(join(work, 'data-mv-b', 'imp.db'), 'another run');
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
    `zfs-host-test: ${work}/data-mv-b already exists; refusing to touch it\n`,
  );

  expect(calls).toBe('sudo zpool list impbenchPID\nzpool list impbenchPID\n');
  expect(readFileSync(join(work, 'data-mv-b', 'imp.db'), 'utf8')).toBe('another run');
  expect(existsSync(join(work, 'data'))).toBeFalse();
});

test('it refuses an imp-zfs-mv-b container that is already there and touches nothing', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs);

  // another run's B answers inspect
  createStubInstanceDocker(ctx.stubs, { containers: ['imp-zfs-mv-b'] });

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
    'zfs-host-test: a container named imp-zfs-mv-b already exists; refusing to touch it\n',
  );

  expect(calls).toBe(
    'sudo zpool list impbenchPID\nzpool list impbenchPID\ndocker container inspect imp-zfs\ndocker container inspect imp-zfs-mv-b\n',
  );

  expect(existsSync(join(work, 'data'))).toBeFalse();
});

test('it refuses an imp-zfs-mv network that is already there and touches nothing', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs);

  // another run's move network answers inspect
  createStubInstanceDocker(ctx.stubs, { containers: [], networks: ['imp-zfs-mv'] });

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
    'zfs-host-test: a network named imp-zfs-mv already exists; refusing to touch it\n',
  );

  expect(calls).toBe(
    'sudo zpool list impbenchPID\nzpool list impbenchPID\ndocker container inspect imp-zfs\ndocker container inspect imp-zfs-mv-b\ndocker network inspect imp-zfs-mv\n',
  );

  expect(existsSync(join(work, 'data'))).toBeFalse();
});

test('it makes a work dir that does not exist yet, parents included', () => {
  const ctx = setupTest();

  createStubInstanceDocker(ctx.stubs, { containers: [] });

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

test('it stops the suites, the moves suites’ B, the instance and the pool when it gets SIGTERM during the run', async () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');
  const started = join(ctx.dir, 'suites-started');

  // the moves suites start B once the run is under way
  createStubInstanceDocker(ctx.stubs, {
    containers: [],
    startedLater: { marker: started, containers: ['imp-zfs-mv-b'] },
  });

  mkdirSync(work);
  createStubZpool(ctx.stubs);

  // a run that holds the instance until something stops it, and a dev.sh
  // that logs which instance each call is for
  createStubRepoScript(ctx.tests, 'test-e2e.sh', ctx.calls, `: >'${started}'; exec sleep 30`);

  createStubRepoScript(
    join(ctx.dir, 'root', 'scripts', 'dev'),
    'dev.sh',
    ctx.calls,
    `printf '%s\\n' "  for $IMP_DEV_NAME on $IMP_DEV_DATA" >>'${ctx.calls}'`,
  );

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

  expect(calls.split('\n').slice(-21)).toStrictEqual([
    'test-e2e.sh --only checkpoints,sleep',
    'docker container inspect imp-zfs-mv-b',
    'docker logs imp-zfs-mv-b',
    'dev.sh down',
    `  for imp-zfs-mv-b on ${work}/data-mv-b`,
    'docker logs imp-zfs',
    'dev.sh down',
    `  for imp-zfs on ${work}/data`,
    'docker network rm imp-zfs-mv',
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

  createStubInstanceDocker(ctx.stubs, { containers: [] });

  const work = join(ctx.dir, 'work');
  const startedMarker = join(ctx.dir, 'create-started');
  const release = join(ctx.dir, 'create-release');

  mkdirSync(work);
  createStubZpool(ctx.stubs, { create: { startedMarker, release } });

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

  // the create holds until the release, so the signal lands inside it
  proc.kill('SIGTERM');

  writeFileSync(release, '');

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

  createStubInstanceDocker(ctx.stubs, { containers: [] });

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

test('it removes its pool file while another pool uses a vdev path that only starts with it', () => {
  const ctx = setupTest();

  createStubInstanceDocker(ctx.stubs, { containers: [] });

  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs);

  // another pool, whose vdev path is this run's bench.img with more after a space
  writeFileSync(join(ctx.stubs, 'pools'), `tank ${work}/bench.img old\n`);

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
  expect(result.stderr.toString()).not.toContain('it stays');
  expect(readFileSync(join(ctx.stubs, 'pools'), 'utf8')).toBe(`tank ${work}/bench.img old\n`);
  expect(existsSync(join(work, 'bench.img'))).toBeFalse();
});

test('it keeps the pool file and fails while another pool uses a vdev path equal to it', () => {
  const ctx = setupTest();

  createStubInstanceDocker(ctx.stubs, { containers: [] });

  const work = join(ctx.dir, 'work');

  mkdirSync(work);
  createStubZpool(ctx.stubs);
  writeFileSync(join(ctx.stubs, 'pools'), `tank ${work}/bench.img\n`);

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

  expect(readFileSync(join(ctx.stubs, 'pools'), 'utf8')).toBe(`tank ${work}/bench.img\n`);
  expect(existsSync(join(work, 'bench.img'))).toBeTrue();
});

test('it destroys its pool and removes the file when the work dir path holds spaces', () => {
  const ctx = setupTest();

  createStubInstanceDocker(ctx.stubs, { containers: [] });

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

  createStubInstanceDocker(ctx.stubs, { containers: [] });

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

test('it refuses to run when the zfs module is not loaded and touches nothing', () => {
  const ctx = setupTest();
  const work = join(ctx.dir, 'work');

  createStubInstanceDocker(ctx.stubs, { containers: [] });
  createStubZpool(ctx.stubs);

  const result = Bun.spawnSync([ctx.script], {
    env: {
      PATH: ctx.path,
      IMP_ZFS_TEST_DIR: work,
      IMP_ZFS_BENCH_GIB: '1',
      IMP_ZFS_MODULE_VERSION_FILE: join(ctx.dir, 'no-zfs-module', 'version'),
    },
  });

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'zfs-host-test: load the zfs module first (sudo modprobe zfs)\n',
  });

  expect(readFileSync(ctx.calls, 'utf8')).toBe('');
  expect(existsSync(work)).toBeFalse();
});
