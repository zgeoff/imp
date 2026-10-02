import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runChecked, runCommand } from '../../process/run-command';
import { createZfsBackend } from './zfs-backend';
import type { CommandRunner } from './zfs-commands';

// Against a real pool, as root: the `zfs` CI job sets these (.github/workflows/
// ci.yml), and scripts/zfs-host-test.sh on a host. Skipped everywhere else.
const POOL_ROOT = process.env['IMP_TEST_ZFS_ROOT'];
const POOL_DIR = process.env['IMP_TEST_ZFS_DIR'];
const DIGEST = 'sha256:real';
const isReal = POOL_ROOT !== undefined && POOL_DIR !== undefined;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

// a fresh root dataset per test, mounted as setup-storage.sh mounts one
async function setupPool(run: CommandRunner = runCommand) {
  const name = `t${String(Date.now())}`;
  const root = `${POOL_ROOT ?? ''}/${name}`;
  const dataDir = join(POOL_DIR ?? '', name);

  await runChecked(['zfs', 'create', '-o', 'mountpoint=legacy', root]);

  mkdirSync(dataDir, { recursive: true });

  await runChecked(['mount', '-t', 'zfs', root, dataDir]);

  cleanups.push(async () => {
    await runCommand(['umount', '-R', dataDir]);
    await runChecked(['zfs', 'destroy', '-R', root]);
  });

  const live = {
    impIds: new Set(['a', 'b', 'c']),
    checkpointIds: new Set(['cp-one', 'cp-two']),
    imageDigests: new Set([DIGEST]),
  };

  const startBackend = async (runner: CommandRunner = run) => {
    const backend = createZfsBackend({ dataDir, root, run: runner, log: () => {} });

    await backend.start(live);

    return backend;
  };

  const backend = await startBackend();

  await backend.createImage(DIGEST, (dir) => {
    writeFileSync(join(dir, 'rootfs.ext4'), 'image');

    return Promise.resolve();
  });

  return { root, dataDir, live, backend, startBackend };
}

test.skipIf(!isReal)('checkpoints, restores and forks keep their bytes', async () => {
  const pool = await setupPool();

  const backend = pool.backend;
  const readDisk = (impId: string) => readFileSync(backend.resolveImpPaths(impId).disk, 'utf8');

  const writeDisk = (impId: string, text: string) => {
    writeFileSync(backend.resolveImpPaths(impId).disk, text);
  };

  await backend.createImpDisk('a', { kind: 'image', digest: DIGEST });

  expect(readDisk('a')).toBe('image');

  writeDisk('a', 'one');

  await runChecked(['sync']);

  await backend.createCheckpoint('a', 'cp-one');

  writeDisk('a', 'two');

  await runChecked(['sync']);

  await backend.createCheckpoint('a', 'cp-two');

  writeDisk('a', 'three');

  await backend.restoreCheckpoint('a', 'cp-one', () => Promise.resolve());

  expect(readDisk('a')).toBe('one');

  // the newer checkpoint survives the restore
  await backend.restoreCheckpoint('a', 'cp-two', () => Promise.resolve());

  expect(readDisk('a')).toBe('two');

  await backend.createImpDisk('b', { kind: 'imp', impId: 'a' });
  await backend.createImpDisk('c', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-one' });

  expect(readDisk('b')).toBe('two');
  expect(readDisk('c')).toBe('one');

  // the source goes while both forks need its blocks
  await backend.removeImpDisk('a', ['cp-one', 'cp-two']);

  expect(readDisk('b')).toBe('two');
  expect(readDisk('c')).toBe('one');

  await backend.removeImpDisk('b', []);
  await backend.removeImpDisk('c', []);
  await backend.waitForReclaim();

  const left = await runChecked(['zfs', 'list', '-H', '-r', '-t', 'all', '-o', 'name', pool.root]);

  // what start made, the image and its @base; nothing retired, staged or forked
  expect(left.trim().split('\n').toSorted()).toEqual(
    [
      pool.root,
      `${pool.root}/disks`,
      `${pool.root}/images`,
      `${pool.root}/images/real`,
      `${pool.root}/images/real@base`,
      `${pool.root}/mem`,
      `${pool.root}/reserve`,
      `${pool.root}/retired`,
      `${pool.root}/staging`,
    ].toSorted(),
  );
});

test.skipIf(!isReal)('a restore cut short is finished by the next start', async () => {
  const pool = await setupPool();

  await pool.backend.createImpDisk('a', { kind: 'image', digest: DIGEST });

  writeFileSync(pool.backend.resolveImpPaths('a').disk, 'one');

  await runChecked(['sync']);

  await pool.backend.createCheckpoint('a', 'cp-one');

  writeFileSync(pool.backend.resolveImpPaths('a').disk, 'two');

  // impd dies after the old disk is retired, before the clone takes its name
  const dying = await pool.startBackend((argv) =>
    argv.join(' ').startsWith(`zfs rename ${pool.root}/staging/`)
      ? Promise.reject(new Error('impd died'))
      : runCommand(argv),
  );

  const restore = dying.restoreCheckpoint('a', 'cp-one', () => Promise.resolve());

  const failure = await restore.catch(String);

  expect(failure).toContain('impd died');

  // a container restart drops every mount but the root
  await runChecked(['umount', join(pool.dataDir, 'mem')]);
  await runChecked(['umount', join(pool.dataDir, 'images', 'real')]);

  await dying.waitForReclaim();

  const restarted = await pool.startBackend();

  expect(readFileSync(restarted.resolveImpPaths('a').disk, 'utf8')).toBe('one');
});

test.skipIf(!isReal)('it reads the usage and real zfs list output parses', async () => {
  const pool = await setupPool();
  const usage = await pool.backend.readUsage();

  expect(usage.usedBytes).toBeGreaterThan(0);
  expect(usage.availableBytes).toBeGreaterThan(0);

  // a record of the real format the unit tests' fixtures copy
  const listed = await runChecked([
    'zfs',
    'list',
    '-Hp',
    '-r',
    '-t',
    'filesystem,snapshot',
    '-s',
    'createtxg',
    '-o',
    'name,type,origin,defer_destroy',
    pool.root,
  ]);

  console.log(listed);

  expect(listed).toContain(`${pool.root}/images/real@base\tsnapshot\t-\toff`);
});
