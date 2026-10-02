import { afterEach, expect, test } from 'bun:test';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { runChecked, runCommand } from '../../process/run-command';
import { createZfsBackend } from './zfs-backend';
import type { ZfsBackend } from './zfs-backend';
import type { CommandRunner } from './zfs-commands';

// Against a real pool, as root: the `zfs` CI job sets these (.github/workflows/
// ci.yml), and scripts/zfs-host-test.sh on a host. Skipped everywhere else.
const POOL_ROOT = process.env['IMP_TEST_ZFS_ROOT'];
const POOL_DIR = process.env['IMP_TEST_ZFS_DIR'];
const DIGEST = 'sha256:real';
const isReal = POOL_ROOT !== undefined && POOL_DIR !== undefined;
const cleanups: (() => Promise<void>)[] = [];

// zfs commands on a shared CI runner take seconds each: bun's default 5 s
// kills a slow test's child processes with SIGTERM (exit 143)
const REAL_TEST_TIMEOUT_MS = 120_000;

// fsync of the one file, not a `sync` of every filesystem on the runner
function writeSyncedFile(path: string, text: string): void {
  const fd = openSync(path, 'w');

  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

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

  const backends: ZfsBackend[] = [];

  cleanups.push(async () => {
    await Promise.all(backends.map((backend) => backend.waitForReclaim()));

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

    backends.push(backend);

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

test.skipIf(!isReal)(
  'checkpoints, restores and forks keep their bytes',
  async () => {
    const pool = await setupPool();

    const backend = pool.backend;
    const readDisk = (impId: string) => readFileSync(backend.resolveImpPaths(impId).disk, 'utf8');

    const writeDisk = (impId: string, text: string) => {
      writeSyncedFile(backend.resolveImpPaths(impId).disk, text);
    };

    await backend.createImpDisk('a', { kind: 'image', digest: DIGEST });

    expect(readDisk('a')).toBe('image');

    writeDisk('a', 'one');

    await backend.createCheckpoint('a', 'cp-one');

    writeDisk('a', 'two');

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

    const left = await runChecked([
      'zfs',
      'list',
      '-H',
      '-r',
      '-t',
      'all',
      '-o',
      'name',
      pool.root,
    ]);

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
  },
  REAL_TEST_TIMEOUT_MS,
);

// The chain #11's retire and reclaim must cover: a template's dataset is a
// clone of its source's disk, and imps are clones of the template.
test.skipIf(!isReal)(
  'a template outlives its source, its imps outlive it, and all of it reclaims',
  async () => {
    const pool = await setupPool();

    const backend = pool.backend;
    const template = 'imp-0199a3b4-0000-7000-8000-000000000001';
    const readDisk = (impId: string) => readFileSync(backend.resolveImpPaths(impId).disk, 'utf8');

    await backend.createImpDisk('a', { kind: 'image', digest: DIGEST });

    writeSyncedFile(backend.resolveImpPaths('a').disk, 'golden');

    await backend.createCheckpoint('a', 'cp-one');

    await backend.createImageFromImp(template, 'a', {
      hold: (clone) => clone(),
      write: (dir) => {
        writeFileSync(join(dir, 'config.json'), '{}');

        return Promise.resolve();
      },
    });

    writeSyncedFile(backend.resolveImpPaths('a').disk, 'changed after');

    await backend.createImpDisk('b', { kind: 'image', digest: template });
    await backend.createImpDisk('c', { kind: 'image', digest: template });

    expect(readDisk('b')).toBe('golden');
    expect(readDisk('c')).toBe('golden');

    // the source goes, then the template, while the imps need their blocks
    await backend.removeImpDisk('a', ['cp-one']);
    await backend.waitForReclaim();
    await backend.removeImage(template);
    await backend.waitForReclaim();

    expect(readDisk('b')).toBe('golden');
    expect(readDisk('c')).toBe('golden');

    await backend.removeImpDisk('b', []);
    await backend.removeImpDisk('c', []);
    await backend.waitForReclaim();

    const left = await runChecked([
      'zfs',
      'list',
      '-H',
      '-r',
      '-t',
      'all',
      '-o',
      'name',
      pool.root,
    ]);

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
  },
  REAL_TEST_TIMEOUT_MS,
);

test.skipIf(!isReal)(
  'a restore cut short is finished by the next start',
  async () => {
    const pool = await setupPool();

    await pool.backend.createImpDisk('a', { kind: 'image', digest: DIGEST });

    writeSyncedFile(pool.backend.resolveImpPaths('a').disk, 'one');

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
  },
  REAL_TEST_TIMEOUT_MS,
);

test.skipIf(!isReal)(
  'it reads the usage and real zfs list output parses',
  async () => {
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
  },
  REAL_TEST_TIMEOUT_MS,
);

// restic skips a file whose inode, mtime, ctime and size match its last run;
// each run's tree is a new clone, so these must survive the clone
test.skipIf(!isReal)(
  'a backup tree file keeps its metadata from run to run',
  async () => {
    const pool = await setupPool();

    const backend = pool.backend;
    const treeDisk = join(pool.dataDir, 'backup', 'tree', 'imps', 'a', 'disk', 'rootfs.ext4');

    await backend.createImpDisk('a', { kind: 'image', digest: DIGEST });

    writeFileSync(backend.resolveImpPaths('a').disk, 'one');

    const readTreeDisk = async (runId: string) => {
      await backend.createBackupCopy('a', runId, { isReusable: true });

      const tree = await backend.openBackupTree({
        runId,
        imps: [{ impId: 'a', checkpointIds: [] }],
        imageDigests: [DIGEST],
      });

      const stats = statSync(treeDisk, { bigint: true });
      const text = readFileSync(treeDisk, 'utf8');

      const touched = await runCommand(['touch', treeDisk]);

      await tree.close();

      return { stats, text, touchExit: touched.exitCode };
    };

    const first = await readTreeDisk('r1');
    const second = await readTreeDisk('r2');

    expect(first.text).toBe('one');
    expect(first.touchExit).not.toBe(0);
    expect(second.stats.ino).toBe(first.stats.ino);
    expect(second.stats.mtimeNs).toBe(first.stats.mtimeNs);
    expect(second.stats.ctimeNs).toBe(first.stats.ctimeNs);

    writeFileSync(backend.resolveImpPaths('a').disk, 'two');

    const third = await readTreeDisk('r3');

    expect(third.text).toBe('two');
    expect(third.stats.mtimeNs).not.toBe(first.stats.mtimeNs);

    await backend.waitForReclaim();

    const left = await runChecked([
      'zfs',
      'list',
      '-H',
      '-t',
      'all',
      '-o',
      'name',
      '-r',
      pool.root,
    ]);

    expect(left).not.toContain('@bk-');
    expect(left).not.toContain('/staging/bk');
  },
  REAL_TEST_TIMEOUT_MS,
);

test.skipIf(!isReal)(
  'an imp destroyed while restic reads it goes once the tree closes',
  async () => {
    const pool = await setupPool();

    const backend = pool.backend;

    await backend.createImpDisk('b', { kind: 'image', digest: DIGEST });
    await backend.createCheckpoint('b', 'cp-one');
    await backend.createBackupCopy('b', 'r1', { isReusable: true });

    const tree = await backend.openBackupTree({
      runId: 'r1',
      imps: [{ impId: 'b', checkpointIds: ['cp-one'] }],
      imageDigests: [DIGEST],
    });

    const treeDisk = join(pool.dataDir, 'backup', 'tree', 'imps', 'b', 'disk', 'rootfs.ext4');

    await backend.removeImpDisk('b', ['cp-one']);
    await backend.waitForReclaim();

    // restic still reads the copy of the destroyed disk
    expect(readFileSync(treeDisk, 'utf8')).toBe('image');

    await tree.close();
    await backend.waitForReclaim();

    const left = await runChecked([
      'zfs',
      'list',
      '-H',
      '-t',
      'all',
      '-o',
      'name',
      '-r',
      pool.root,
    ]);

    expect(left).not.toContain('/retired/');
    expect(left).not.toContain('/staging/');
    expect(left).not.toContain('@bk-');
  },
  REAL_TEST_TIMEOUT_MS,
);

// The GC's sweep with storage the database names only in part: what the
// storage gate keeps from overlapping must still never break
test.skipIf(!isReal)(
  'a GC keeps a fork of a destroyed imp, an open backup tree, a staged restore and a build',
  async () => {
    const pool = await setupPool();

    const backend = pool.backend;
    const readDisk = (impId: string) => readFileSync(backend.resolveImpPaths(impId).disk, 'utf8');

    await backend.createImpDisk('a', { kind: 'image', digest: DIGEST });

    writeSyncedFile(backend.resolveImpPaths('a').disk, 'from a');

    await backend.createCheckpoint('a', 'cp-one');

    // b forks a's checkpoint, then a goes: b's origin now lives in retired/
    await backend.createImpDisk('b', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-one' });
    await backend.removeImpDisk('a', ['cp-one']);
    await backend.createBackupCopy('b', 'r1', { isReusable: true });

    const tree = await backend.openBackupTree({
      runId: 'r1',
      imps: [{ impId: 'b', checkpointIds: [] }],
      imageDigests: [DIGEST],
    });

    // a restore between its clone and its swap
    await backend.createImpDisk('c', { kind: 'image', digest: DIGEST });
    await backend.createCheckpoint('c', 'cp-two');

    await runChecked([
      'zfs',
      'clone',
      `${pool.root}/disks/c@cp-two`,
      `${pool.root}/staging/restore-c`,
    ]);

    const live = {
      impIds: new Set(['b', 'c']),
      checkpointIds: new Set(['cp-two']),
      imageDigests: new Set([DIGEST]),
    };

    // the sweep runs while an image build writes, before the image has a row
    const swept: { dropped: readonly { kind: string; id: string }[] } = { dropped: [] };

    await backend.createImage('sha256:building', async (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'new image');

      swept.dropped = await backend.dropUnnamed(live, { isDryRun: false });
    });

    const treeDisk = join(pool.dataDir, 'backup', 'tree', 'imps', 'b', 'disk', 'rootfs.ext4');
    const treeText = readFileSync(treeDisk, 'utf8');

    await tree.close();
    await backend.waitForReclaim();

    const datasets = await runChecked(['zfs', 'list', '-H', '-o', 'name', '-r', pool.root]);

    console.log(swept.dropped, datasets);

    const droppedIds = swept.dropped.map((dropped) => dropped.id);

    expect(droppedIds.filter((id) => ['b', 'c', 'cp-two'].includes(id))).toEqual([]);

    expect(droppedIds.filter((id) => id.includes('staging') || id.includes('building'))).toEqual(
      [],
    );

    expect(readDisk('b')).toBe('from a');
    expect(treeText).toBe('from a');
    expect(datasets).toContain(`${pool.root}/staging/restore-c\n`);
    expect(datasets).toContain(`${pool.root}/images/building\n`);

    expect(readFileSync(join(pool.dataDir, 'images', 'building', 'rootfs.ext4'), 'utf8')).toBe(
      'new image',
    );
  },
  REAL_TEST_TIMEOUT_MS,
);
