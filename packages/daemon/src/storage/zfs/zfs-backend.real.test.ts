import { expect, mock, onTestFinished, test } from 'bun:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { runChecked, runCommand } from '../../process/run-command';
import { createZfsTestDataset } from '../../test-utils/create-zfs-test-dataset';
import { readZfsTestPool } from '../../test-utils/read-zfs-test-pool';
import { writeSyncedFile } from '../../test-utils/write-synced-file';
import { createZfsBackend } from './zfs-backend';
import type { CommandRunner } from './zfs-commands';

// Against a real pool, as root: scripts/test-zfs.sh sets the pool, in the
// `zfs` CI job and on a host. Each test skips everywhere else.

// zfs commands on a shared CI runner take seconds each, so each test gets
// 120 s: bun's default 5 s kills a slow test's children with SIGTERM.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const pool = readZfsTestPool();

  invariant(pool);

  const dataset = await createZfsTestDataset(stack, pool);

  // a new impd on the same dataset; its reclaim ends before the dataset goes
  const startBackend = (
    run: CommandRunner = runCommand,
    log: (message: string) => void = () => {},
  ) => {
    const backend = createZfsBackend({ dataDir: dataset.dataDir, root: dataset.root, run, log });

    stack.defer(() => backend.waitForReclaim());

    return backend;
  };

  // a backup tree the test opens closes into this stack, before the dataset goes
  return {
    stack,
    root: dataset.root,
    dataDir: dataset.dataDir,
    backend: startBackend(),
    startBackend,
  };
}

test.skipIf(readZfsTestPool() === null)(
  'it keeps the bytes of each checkpoint, restore and fork',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(['a', 'b', 'c']),
      checkpointIds: new Set(['cp-one', 'cp-two']),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:real' });

    const cloned = readFileSync(ctx.backend.resolveImpPaths('a').disk, 'utf8');

    writeSyncedFile(ctx.backend.resolveImpPaths('a').disk, 'one');

    await ctx.backend.createCheckpoint('a', 'cp-one');

    writeSyncedFile(ctx.backend.resolveImpPaths('a').disk, 'two');

    await ctx.backend.createCheckpoint('a', 'cp-two');

    writeSyncedFile(ctx.backend.resolveImpPaths('a').disk, 'three');

    await ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.resolve());

    const restoredOld = readFileSync(ctx.backend.resolveImpPaths('a').disk, 'utf8');

    // the newer checkpoint survives the restore
    await ctx.backend.restoreCheckpoint('a', 'cp-two', () => Promise.resolve());

    const restoredNew = readFileSync(ctx.backend.resolveImpPaths('a').disk, 'utf8');

    await ctx.backend.createImpDisk('b', { kind: 'imp', impId: 'a' });

    await ctx.backend.createImpDisk('c', {
      kind: 'checkpoint',
      impId: 'a',
      checkpointId: 'cp-one',
    });

    // the source goes while both forks need its blocks
    await ctx.backend.removeImpDisk('a', ['cp-one', 'cp-two']);

    expect(cloned).toBe('image');
    expect(restoredOld).toBe('one');
    expect(restoredNew).toBe('two');
    expect(readFileSync(ctx.backend.resolveImpPaths('b').disk, 'utf8')).toBe('two');
    expect(readFileSync(ctx.backend.resolveImpPaths('c').disk, 'utf8')).toBe('one');
  },
  120_000,
);

test.skipIf(readZfsTestPool() === null)(
  'it reclaims every fork and retired disk once the imps are gone',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(['a', 'b', 'c']),
      checkpointIds: new Set(['cp-one', 'cp-two']),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:real' });
    await ctx.backend.createCheckpoint('a', 'cp-one');
    await ctx.backend.createCheckpoint('a', 'cp-two');
    await ctx.backend.restoreCheckpoint('a', 'cp-one', () => Promise.resolve());
    await ctx.backend.createImpDisk('b', { kind: 'imp', impId: 'a' });

    await ctx.backend.createImpDisk('c', {
      kind: 'checkpoint',
      impId: 'a',
      checkpointId: 'cp-one',
    });

    await ctx.backend.removeImpDisk('a', ['cp-one', 'cp-two']);
    await ctx.backend.removeImpDisk('b', []);
    await ctx.backend.removeImpDisk('c', []);
    await ctx.backend.waitForReclaim();

    const left = await runChecked(['zfs', 'list', '-H', '-r', '-t', 'all', '-o', 'name', ctx.root]);

    // what start made, the image and its @base; nothing retired, staged or forked
    expect(left.trim().split('\n')).toIncludeSameMembers([
      ctx.root,
      `${ctx.root}/disks`,
      `${ctx.root}/images`,
      `${ctx.root}/images/real`,
      `${ctx.root}/images/real@base`,
      `${ctx.root}/mem`,
      `${ctx.root}/reserve`,
      `${ctx.root}/retired`,
      `${ctx.root}/staging`,
    ]);
  },
  120_000,
);

// The chain the retire and reclaim must cover: a template's dataset is a clone
// of its source's disk, and imps are clones of the template.
test.skipIf(readZfsTestPool() === null)(
  'it keeps the imps of a template whole after the source and the template go',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(['a', 'b', 'c']),
      checkpointIds: new Set(['cp-one']),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:real' });

    writeSyncedFile(ctx.backend.resolveImpPaths('a').disk, 'golden');

    await ctx.backend.createCheckpoint('a', 'cp-one');

    await ctx.backend.createImageFromImp('imp-0199a3b4-0000-7000-8000-000000000001', 'a', {
      hold: (clone) => clone(),
      write: (dir) => {
        writeFileSync(join(dir, 'config.json'), '{}');

        return Promise.resolve();
      },
    });

    writeSyncedFile(ctx.backend.resolveImpPaths('a').disk, 'changed after');

    await ctx.backend.createImpDisk('b', {
      kind: 'image',
      digest: 'imp-0199a3b4-0000-7000-8000-000000000001',
    });

    await ctx.backend.createImpDisk('c', {
      kind: 'image',
      digest: 'imp-0199a3b4-0000-7000-8000-000000000001',
    });

    // the source goes, then the template, while the imps need their blocks
    await ctx.backend.removeImpDisk('a', ['cp-one']);
    await ctx.backend.waitForReclaim();
    await ctx.backend.removeImage('imp-0199a3b4-0000-7000-8000-000000000001');
    await ctx.backend.waitForReclaim();

    expect(readFileSync(ctx.backend.resolveImpPaths('b').disk, 'utf8')).toBe('golden');
    expect(readFileSync(ctx.backend.resolveImpPaths('c').disk, 'utf8')).toBe('golden');
  },
  120_000,
);

test.skipIf(readZfsTestPool() === null)(
  'it reclaims a template, its source and its imps once all of them go',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(['a', 'b', 'c']),
      checkpointIds: new Set(['cp-one']),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:real' });
    await ctx.backend.createCheckpoint('a', 'cp-one');

    await ctx.backend.createImageFromImp('imp-0199a3b4-0000-7000-8000-000000000001', 'a', {
      hold: (clone) => clone(),
      write: () => Promise.resolve(),
    });

    await ctx.backend.createImpDisk('b', {
      kind: 'image',
      digest: 'imp-0199a3b4-0000-7000-8000-000000000001',
    });

    await ctx.backend.createImpDisk('c', {
      kind: 'image',
      digest: 'imp-0199a3b4-0000-7000-8000-000000000001',
    });

    await ctx.backend.removeImpDisk('a', ['cp-one']);
    await ctx.backend.waitForReclaim();
    await ctx.backend.removeImage('imp-0199a3b4-0000-7000-8000-000000000001');
    await ctx.backend.waitForReclaim();
    await ctx.backend.removeImpDisk('b', []);
    await ctx.backend.removeImpDisk('c', []);
    await ctx.backend.waitForReclaim();

    const left = await runChecked(['zfs', 'list', '-H', '-r', '-t', 'all', '-o', 'name', ctx.root]);

    expect(left.trim().split('\n')).toIncludeSameMembers([
      ctx.root,
      `${ctx.root}/disks`,
      `${ctx.root}/images`,
      `${ctx.root}/images/real`,
      `${ctx.root}/images/real@base`,
      `${ctx.root}/mem`,
      `${ctx.root}/reserve`,
      `${ctx.root}/retired`,
      `${ctx.root}/staging`,
    ]);
  },
  120_000,
);

test.skipIf(readZfsTestPool() === null)(
  'it finishes at the next start a restore that a crash cut short',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(['a']),
      checkpointIds: new Set(['cp-one']),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:real' });

    writeSyncedFile(ctx.backend.resolveImpPaths('a').disk, 'one');

    await ctx.backend.createCheckpoint('a', 'cp-one');

    writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'two');

    // impd dies after the old disk is retired, before the clone takes its name
    const dying = ctx.startBackend((argv) =>
      argv.join(' ').startsWith(`zfs rename ${ctx.root}/staging/`)
        ? Promise.reject(new Error('impd died'))
        : runCommand(argv),
    );

    await dying.start({
      impIds: new Set(['a']),
      checkpointIds: new Set(['cp-one']),
      imageDigests: new Set(['sha256:real']),
    });

    expect(
      dying.restoreCheckpoint('a', 'cp-one', () => Promise.resolve()),
    ).rejects.toThrowWithMessage(Error, 'impd died');

    // a container restart drops every mount but the root
    await runChecked(['umount', join(ctx.dataDir, 'mem')]);
    await runChecked(['umount', join(ctx.dataDir, 'images', 'real')]);

    await dying.waitForReclaim();

    const restarted = ctx.startBackend();

    await restarted.start({
      impIds: new Set(['a']),
      checkpointIds: new Set(['cp-one']),
      imageDigests: new Set(['sha256:real']),
    });

    expect(readFileSync(restarted.resolveImpPaths('a').disk, 'utf8')).toBe('one');
  },
  120_000,
);

test.skipIf(readZfsTestPool() === null)(
  'it reads a used and an available byte count of the pool',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(),
      checkpointIds: new Set(),
      imageDigests: new Set(),
    });

    const usage = await ctx.backend.readUsage();

    expect(usage.usedBytes).toBePositive();
    expect(usage.availableBytes).toBePositive();
  },
  120_000,
);

// a record of the real format that the stand-in's rows copy
test.skipIf(readZfsTestPool() === null)(
  'it gets zfs list rows in the format the stand-in gives',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(),
      checkpointIds: new Set(),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

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
      ctx.root,
    ]);

    expect(listed).toInclude(`${ctx.root}/images/real@base\tsnapshot\t-\toff\n`);
  },
  120_000,
);

// restic skips a file whose inode, mtime, ctime and size match its last run;
// each run's tree is a new clone, so these must survive the clone
test.skipIf(readZfsTestPool() === null)(
  'it keeps the metadata of a backup tree file from run to run',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(['a']),
      checkpointIds: new Set(),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:real' });

    writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'one');

    await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

    const firstTree = await ctx.backend.openBackupTree({
      runId: 'r1',
      imps: [{ impId: 'a', checkpointIds: [] }],
      imageDigests: ['sha256:real'],
    });

    const treeDisk = join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'disk', 'rootfs.ext4');
    const first = statSync(treeDisk, { bigint: true });
    const firstText = readFileSync(treeDisk, 'utf8');

    const touched = await runCommand(['touch', treeDisk]);

    await firstTree.close();
    await ctx.backend.createBackupCopy('a', 'r2', { isReusable: true });

    const secondTree = await ctx.backend.openBackupTree({
      runId: 'r2',
      imps: [{ impId: 'a', checkpointIds: [] }],
      imageDigests: ['sha256:real'],
    });

    ctx.stack.defer(() => secondTree.close());

    const second = statSync(treeDisk, { bigint: true });

    expect(firstText).toBe('one');
    expect(touched.exitCode).not.toBe(0);
    expect(second.ino).toBe(first.ino);
    expect(second.mtimeNs).toBe(first.mtimeNs);
    expect(second.ctimeNs).toBe(first.ctimeNs);
  },
  120_000,
);

test.skipIf(readZfsTestPool() === null)(
  'it gives a backup tree file a new mtime once the disk changes',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(['a']),
      checkpointIds: new Set(),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:real' });

    writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'one');

    await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

    const firstTree = await ctx.backend.openBackupTree({
      runId: 'r1',
      imps: [{ impId: 'a', checkpointIds: [] }],
      imageDigests: ['sha256:real'],
    });

    const treeDisk = join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'disk', 'rootfs.ext4');
    const first = statSync(treeDisk, { bigint: true });

    await firstTree.close();

    writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'two');

    await ctx.backend.createBackupCopy('a', 'r2', { isReusable: true });

    const secondTree = await ctx.backend.openBackupTree({
      runId: 'r2',
      imps: [{ impId: 'a', checkpointIds: [] }],
      imageDigests: ['sha256:real'],
    });

    ctx.stack.defer(() => secondTree.close());

    expect(readFileSync(treeDisk, 'utf8')).toBe('two');
    expect(statSync(treeDisk, { bigint: true }).mtimeNs).not.toBe(first.mtimeNs);
  },
  120_000,
);

test.skipIf(readZfsTestPool() === null)(
  'it leaves no backup snapshot or clone once each run closes its tree',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(['a']),
      checkpointIds: new Set(),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:real' });
    await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

    const firstTree = await ctx.backend.openBackupTree({
      runId: 'r1',
      imps: [{ impId: 'a', checkpointIds: [] }],
      imageDigests: ['sha256:real'],
    });

    await firstTree.close();
    await ctx.backend.createBackupCopy('a', 'r2', { isReusable: true });

    const secondTree = await ctx.backend.openBackupTree({
      runId: 'r2',
      imps: [{ impId: 'a', checkpointIds: [] }],
      imageDigests: ['sha256:real'],
    });

    await secondTree.close();
    await ctx.backend.waitForReclaim();

    const left = await runChecked(['zfs', 'list', '-H', '-t', 'all', '-o', 'name', '-r', ctx.root]);

    expect(left).not.toInclude('@bk-');
    expect(left).not.toInclude('/staging/bk');
  },
  120_000,
);

test.skipIf(readZfsTestPool() === null)(
  'it keeps the copy of an imp destroyed while restic reads it',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(['b']),
      checkpointIds: new Set(['cp-one']),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:real' });
    await ctx.backend.createCheckpoint('b', 'cp-one');
    await ctx.backend.createBackupCopy('b', 'r1', { isReusable: true });

    const tree = await ctx.backend.openBackupTree({
      runId: 'r1',
      imps: [{ impId: 'b', checkpointIds: ['cp-one'] }],
      imageDigests: ['sha256:real'],
    });

    ctx.stack.defer(() => tree.close());

    await ctx.backend.removeImpDisk('b', ['cp-one']);
    await ctx.backend.waitForReclaim();

    expect(
      readFileSync(join(ctx.dataDir, 'backup', 'tree', 'imps', 'b', 'disk', 'rootfs.ext4'), 'utf8'),
    ).toBe('image');
  },
  120_000,
);

test.skipIf(readZfsTestPool() === null)(
  'it reclaims an imp destroyed while restic reads it once the tree closes',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(['b']),
      checkpointIds: new Set(['cp-one']),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:real' });
    await ctx.backend.createCheckpoint('b', 'cp-one');
    await ctx.backend.createBackupCopy('b', 'r1', { isReusable: true });

    const tree = await ctx.backend.openBackupTree({
      runId: 'r1',
      imps: [{ impId: 'b', checkpointIds: ['cp-one'] }],
      imageDigests: ['sha256:real'],
    });

    await ctx.backend.removeImpDisk('b', ['cp-one']);
    await ctx.backend.waitForReclaim();
    await tree.close();
    await ctx.backend.waitForReclaim();

    const left = await runChecked(['zfs', 'list', '-H', '-t', 'all', '-o', 'name', '-r', ctx.root]);

    expect(left).not.toInclude('/retired/');
    expect(left).not.toInclude('/staging/');
    expect(left).not.toInclude('@bk-');
  },
  120_000,
);

// The GC's sweep with storage the database names only in part: what the
// storage gate keeps from overlapping must still never break
test.skipIf(readZfsTestPool() === null)(
  'it keeps a fork of a destroyed imp, an open backup tree, a staged restore and a build through a GC',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(['a', 'b', 'c']),
      checkpointIds: new Set(['cp-one', 'cp-two']),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:real' });

    writeSyncedFile(ctx.backend.resolveImpPaths('a').disk, 'from a');

    await ctx.backend.createCheckpoint('a', 'cp-one');

    // b forks a's checkpoint, then a goes: b's origin now lives in retired/
    await ctx.backend.createImpDisk('b', {
      kind: 'checkpoint',
      impId: 'a',
      checkpointId: 'cp-one',
    });

    await ctx.backend.removeImpDisk('a', ['cp-one']);
    await ctx.backend.createBackupCopy('b', 'r1', { isReusable: true });

    const tree = await ctx.backend.openBackupTree({
      runId: 'r1',
      imps: [{ impId: 'b', checkpointIds: [] }],
      imageDigests: ['sha256:real'],
    });

    ctx.stack.defer(() => tree.close());

    // a restore between its clone and its swap
    await ctx.backend.createImpDisk('c', { kind: 'image', digest: 'sha256:real' });
    await ctx.backend.createCheckpoint('c', 'cp-two');

    await runChecked([
      'zfs',
      'clone',
      `${ctx.root}/disks/c@cp-two`,
      `${ctx.root}/staging/restore-c`,
    ]);

    // the sweep runs while an image build writes, before the image has a row
    const swept: { dropped: readonly { kind: string; id: string }[] } = { dropped: [] };

    await ctx.backend.createImage('sha256:building', async (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'new image');

      const result = await ctx.backend.dropUnnamed(
        {
          impIds: new Set(['b', 'c']),
          checkpointIds: new Set(['cp-two']),
          imageDigests: new Set(['sha256:real']),
        },
        { isDryRun: false, isOrphans: false },
      );

      swept.dropped = result.dropped;
    });

    const datasets = await runChecked(['zfs', 'list', '-H', '-o', 'name', '-r', ctx.root]);

    expect(
      swept.dropped
        .map((dropped) => dropped.id)
        .filter((id) => ['b', 'c', 'cp-two'].includes(id) || /staging|building/.test(id)),
    ).toStrictEqual([]);

    expect(readFileSync(ctx.backend.resolveImpPaths('b').disk, 'utf8')).toBe('from a');

    expect(
      readFileSync(join(ctx.dataDir, 'backup', 'tree', 'imps', 'b', 'disk', 'rootfs.ext4'), 'utf8'),
    ).toBe('from a');

    expect(datasets).toInclude(`${ctx.root}/staging/restore-c\n`);
    expect(datasets).toInclude(`${ctx.root}/images/building\n`);

    expect(readFileSync(join(ctx.dataDir, 'images', 'building', 'rootfs.ext4'), 'utf8')).toBe(
      'new image',
    );
  },
  120_000,
);

// A database lost with the pool kept: a new impd keeps every disk, image and
// checkpoint, and only `imp gc --orphans` retires them, for the reclaim to free
test.skipIf(readZfsTestPool() === null)(
  'it keeps every dataset at a start after a lost database',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(['a', 'b']),
      checkpointIds: new Set(['cp-one']),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:real' });

    writeSyncedFile(ctx.backend.resolveImpPaths('a').disk, 'from a');

    await ctx.backend.createCheckpoint('a', 'cp-one');

    await ctx.backend.createImpDisk('b', {
      kind: 'checkpoint',
      impId: 'a',
      checkpointId: 'cp-one',
    });

    const log = mock<(message: string) => void>();
    const restarted = ctx.startBackend(runCommand, log);

    await restarted.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

    const names = await runChecked([
      'zfs',
      'list',
      '-H',
      '-o',
      'name',
      '-t',
      'all',
      '-r',
      ctx.root,
    ]);

    expect(
      log.mock.calls.map(([line]) => line).filter((line) => line.includes('kept orphan')),
    ).toHaveLength(3);

    expect(
      names.split('\n').filter((name) => /\/(?:disks|images|retired)\//.test(name)),
    ).toIncludeSameMembers([
      `${ctx.root}/disks/a`,
      `${ctx.root}/disks/a@cp-one`,
      `${ctx.root}/disks/b`,
      `${ctx.root}/images/real`,
      `${ctx.root}/images/real@base`,
    ]);

    expect(readFileSync(restarted.resolveImpPaths('a').disk, 'utf8')).toBe('from a');
  },
  120_000,
);

test.skipIf(readZfsTestPool() === null)(
  'it retires every orphan of a lost database for the reclaim to free',
  async () => {
    const ctx = await setupTest();

    await ctx.backend.start({
      impIds: new Set(['a', 'b']),
      checkpointIds: new Set(['cp-one']),
      imageDigests: new Set(['sha256:real']),
    });

    await ctx.backend.createImage('sha256:real', (dir) => {
      writeFileSync(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:real' });
    await ctx.backend.createCheckpoint('a', 'cp-one');

    await ctx.backend.createImpDisk('b', {
      kind: 'checkpoint',
      impId: 'a',
      checkpointId: 'cp-one',
    });

    const restarted = ctx.startBackend();

    await restarted.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

    const retired = await restarted.dropUnnamed(
      { impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() },
      { isDryRun: false, isOrphans: true },
    );

    await restarted.waitForReclaim();

    const names = await runChecked([
      'zfs',
      'list',
      '-H',
      '-o',
      'name',
      '-t',
      'all',
      '-r',
      ctx.root,
    ]);

    expect(retired.dropped).toIncludeSameMembers([
      { kind: 'checkpoint', id: 'cp-one' },
      { kind: 'image', id: 'real' },
      { kind: 'imp', id: 'a' },
      { kind: 'imp', id: 'b' },
    ]);

    expect(
      names.split('\n').filter((name) => /\/(?:disks|images|retired)\//.test(name)),
    ).toStrictEqual([]);
  },
  120_000,
);
