import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { writeChangedBlocks } from '../../backup/write-changed-blocks';
import { createZfsTestDataset } from '../../test-utils/create-zfs-test-dataset';
import { readZfsTestPool } from '../../test-utils/read-zfs-test-pool';
import { writeSyncedFile } from '../../test-utils/write-synced-file';
import { createZfsBackend } from './zfs-backend';

// Moves between two impds on one real pool, as root: scripts/test-zfs.sh sets
// the pool, in the `zfs` CI job and on a host. Each test skips elsewhere.

// zfs commands on a shared CI runner take seconds each: each test gets 180 s
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const pool = readZfsTestPool();

  invariant(pool);

  const sourceSet = await createZfsTestDataset(stack, pool);
  const targetSet = await createZfsTestDataset(stack, pool);

  // each impd's reclaim ends before its dataset goes
  const source = createZfsBackend({
    dataDir: sourceSet.dataDir,
    root: sourceSet.root,
    log: () => {},
  });

  stack.defer(() => source.waitForReclaim());

  const target = createZfsBackend({
    dataDir: targetSet.dataDir,
    root: targetSet.root,
    log: () => {},
  });

  stack.defer(() => target.waitForReclaim());

  await source.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });
  await target.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  // a move source the test opens closes into this stack, before both datasets go
  return { stack, source, target };
}

test.skipIf(readZfsTestPool() === null)(
  'it moves a restored imp to another ZFS host with every checkpoint and its disk',
  async () => {
    const ctx = await setupTest();

    await ctx.source.createImage('sha256:real', (dir) => {
      writeSyncedFile(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.target.createImage('sha256:real', (dir) => {
      writeSyncedFile(join(dir, 'rootfs.ext4'), 'image');

      return Promise.resolve();
    });

    await ctx.source.createImpDisk('a', { kind: 'image', digest: 'sha256:real' });

    writeSyncedFile(ctx.source.resolveImpPaths('a').disk, 'one');

    await ctx.source.createCheckpoint('a', 'cp-one');

    writeSyncedFile(ctx.source.resolveImpPaths('a').disk, 'two');

    await ctx.source.createCheckpoint('a', 'cp-two');
    await ctx.source.restoreCheckpoint('a', 'cp-one', () => Promise.resolve());

    writeSyncedFile(ctx.source.resolveImpPaths('a').disk, 'three');

    await ctx.source.createCheckpoint('a', 'cp-three');

    writeSyncedFile(ctx.source.resolveImpPaths('a').disk, 'four');

    const moving = await ctx.source.openMoveSource('a', ['cp-one', 'cp-two', 'cp-three'], 'zfs');

    ctx.stack.defer(() => moving.close());

    if (moving.kind !== 'zfs') {
      throw new Error('expected a ZFS move source');
    }

    const ids = ['cp-new1', 'cp-new2', 'cp-new3'];

    const received = await ctx.target.receiveMoveSnapshots(
      'a',
      moving.steps.map((step) => ({
        isCheckpoint: step.checkpointId !== null,
        dataset: step.dataset,
        base: step.base,
      })),
      (index) => moving.steps[index]?.open().stdout ?? new ReadableStream(),
      () => ids.shift() ?? 'cp-none',
    );

    const landed = await ctx.target.openMoveSource(
      'a',
      received.map((checkpoint) => checkpoint.id),
      'files',
    );

    ctx.stack.defer(() => landed.close());

    if (landed.kind !== 'files') {
      throw new Error('expected a files move source');
    }

    expect(moving.steps.map((step) => step.base)).toStrictEqual([null, 0, 0, 2]);

    expect(
      [...landed.checkpointPaths, landed.diskPath].map((path) => readFileSync(path, 'utf8')),
    ).toStrictEqual(['one', 'two', 'three', 'four']);
  },
  180_000,
);

test.skipIf(readZfsTestPool() === null)(
  'it lands a move from XFS on ZFS as a disk written block by block, checkpoints as snapshots',
  async () => {
    const ctx = await setupTest();

    const incomingDir = mkdtempSync(join(tmpdir(), 'zfs-move-incoming-'));

    onTestFinished(() => {
      rmSync(incomingDir, { recursive: true, force: true });
    });

    await ctx.target.createImpDisk('a', { kind: 'empty' });

    // as the receiver does: each file into a temp file, then over the disk
    for (const [index, text] of ['one', 'two'].entries()) {
      writeSyncedFile(join(incomingDir, 'incoming'), text);

      await writeChangedBlocks(join(incomingDir, 'incoming'), ctx.target.resolveImpPaths('a').disk);

      await ctx.target.createCheckpoint('a', `cp-x${String(index)}`);
    }

    writeSyncedFile(join(incomingDir, 'incoming'), 'three');

    await writeChangedBlocks(join(incomingDir, 'incoming'), ctx.target.resolveImpPaths('a').disk);

    const landed = await ctx.target.openMoveSource('a', ['cp-x0', 'cp-x1'], 'files');

    ctx.stack.defer(() => landed.close());

    if (landed.kind !== 'files') {
      throw new Error('expected a files move source');
    }

    expect(
      [...landed.checkpointPaths, landed.diskPath].map((path) => readFileSync(path, 'utf8')),
    ).toStrictEqual(['one', 'two', 'three']);
  },
  180_000,
);
