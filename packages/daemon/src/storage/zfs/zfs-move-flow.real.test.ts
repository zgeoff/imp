import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { createImage } from '../../db/images';
import { findImpByName } from '../../db/imps';
import { createMoveHosts } from '../../moves/test-moves';
import { runChecked } from '../../process/run-command';
import { readSnapshotMeta } from '../../sleep/snapshot-meta';
import { createZfsTestDataset } from '../../test-utils/create-zfs-test-dataset';
import { readZfsTestPool } from '../../test-utils/read-zfs-test-pool';
import { writeSyncedFile } from '../../test-utils/write-synced-file';
import { createZfsBackend } from './zfs-backend';
import type { ZfsBackend } from './zfs-backend';

// Whole moves, as `imp move` runs them, between two impds on one real pool,
// as root: scripts/test-zfs.sh sets the pool, in the `zfs` CI job and on a
// host. Each test skips everywhere else; only the VMs are fakes.

// zfs commands on a shared CI runner take seconds each: each test gets 180 s
// and each move 120 s
async function setupTest(options: Readonly<{ isShared?: boolean }> = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const pool = readZfsTestPool();

  invariant(pool);

  const sourceSet = await createZfsTestDataset(stack, pool);
  const targetSet = await createZfsTestDataset(stack, pool);

  // the stack runs in reverse: both impds stop, then their reclaims end, then
  // their datasets go
  const backends: ZfsBackend[] = [];

  stack.defer(async () => {
    await Promise.all(backends.map((backend) => backend.waitForReclaim()));
  });

  const hosts = await createMoveHosts(stack, {
    isShared: options.isShared === true,
    source: {
      dataDir: sourceSet.dataDir,
      createStorage: (dir) => {
        const backend = createZfsBackend({ dataDir: dir, root: sourceSet.root, log: () => {} });

        backends.push(backend);

        return backend;
      },
    },
    target: {
      dataDir: targetSet.dataDir,
      createStorage: (dir) => {
        const backend = createZfsBackend({ dataDir: dir, root: targetSet.root, log: () => {} });

        backends.push(backend);

        return backend;
      },
    },
    moveTimeoutMs: 120_000,
  });

  await hosts.source.storage.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  await hosts.target.storage.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  return { ...hosts, sourceRoot: sourceSet.root, targetRoot: targetSet.root };
}

test.skipIf(readZfsTestPool() === null)(
  'it moves a stopped imp cold between two ZFS impds with its checkpoint and its disk',
  async () => {
    const ctx = await setupTest();

    await ctx.source.storage.createImage('sha256:ubuntu', (dir) => {
      writeSyncedFile(join(dir, 'rootfs.ext4'), 'rootfs');
      writeSyncedFile(join(dir, 'config.json'), '{}');

      return Promise.resolve();
    });

    await createImage(ctx.source.db, {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
    });

    await ctx.target.storage.createImage('sha256:ubuntu', (dir) => {
      writeSyncedFile(join(dir, 'rootfs.ext4'), 'rootfs');
      writeSyncedFile(join(dir, 'config.json'), '{}');

      return Promise.resolve();
    });

    await createImage(ctx.target.db, {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
    });

    const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

    await ctx.sourceApp.client.imps.stop({ name: 'dev' });

    writeSyncedFile(ctx.source.storage.resolveImpPaths(created.id).disk, 'hello');

    await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

    writeSyncedFile(ctx.source.storage.resolveImpPaths(created.id).disk, 'world');

    const status = await ctx.runMove('dev');
    const moved = await ctx.targetApp.client.imps.get({ name: 'dev' });
    const checkpoints = await ctx.targetApp.client.checkpoints.list({ name: 'dev' });
    const left = await findImpByName(ctx.source.db, 'dev');

    const movedDisk = readFileSync(ctx.target.storage.resolveImpPaths(created.id).disk, 'utf8');

    const targetSets = await runChecked([
      'zfs',
      'list',
      '-H',
      '-o',
      'name',
      '-t',
      'all',
      '-r',
      ctx.targetRoot,
    ]);

    const sourceSets = await runChecked([
      'zfs',
      'list',
      '-H',
      '-o',
      'name',
      '-t',
      'all',
      '-r',
      ctx.sourceRoot,
    ]);

    const started = await ctx.targetApp.client.imps.start({ name: 'dev' });

    expect(status).toMatchObject({ isDone: true, error: null });
    expect(moved).toMatchObject({ id: created.id, state: 'stopped' });
    expect(moved.move).toBeUndefined();
    expect(checkpoints.map((checkpoint) => checkpoint.label)).toStrictEqual(['one']);
    expect(movedDisk).toStartWith('world');

    expect(targetSets.split('\n')).toContain(
      `${ctx.targetRoot}/disks/${created.id}@${checkpoints[0]?.id ?? ''}`,
    );

    expect(sourceSets).not.toInclude(created.id);
    expect(left).toBeUndefined();
    expect(started.state).toBe('running');
  },
  180_000,
);

test.skipIf(readZfsTestPool() === null)(
  'it moves a sleeping imp warm between two ZFS impds into its slot, and wakes it from its memory',
  async () => {
    // two impds in one process differ in their data dirs: both report the
    // target's facts, as two hosts with the same IMP_DATA_DIR would
    const ctx = await setupTest({ isShared: true });

    await ctx.source.storage.createImage('sha256:ubuntu', (dir) => {
      writeSyncedFile(join(dir, 'rootfs.ext4'), 'rootfs');
      writeSyncedFile(join(dir, 'config.json'), '{}');

      return Promise.resolve();
    });

    await createImage(ctx.source.db, {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
    });

    await ctx.target.storage.createImage('sha256:ubuntu', (dir) => {
      writeSyncedFile(join(dir, 'rootfs.ext4'), 'rootfs');
      writeSyncedFile(join(dir, 'config.json'), '{}');

      return Promise.resolve();
    });

    await createImage(ctx.target.db, {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
    });

    // slot 0 goes to another imp, so the target's lowest free slot is not dev's
    await ctx.sourceApp.client.imps.create({ name: 'first', image: 'ubuntu' });

    const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

    writeSyncedFile(ctx.source.storage.resolveImpPaths(created.id).disk, 'warm');

    await ctx.sourceApp.client.imps.sleep({ name: 'dev' });

    const status = await ctx.runMove('dev');
    const moved = await findImpByName(ctx.target.db, 'dev');

    const paths = ctx.target.storage.resolveImpPaths(created.id);
    const meta = readSnapshotMeta(paths);
    const mem = readFileSync(paths.memFile, 'utf8');
    const movedDisk = readFileSync(paths.disk, 'utf8');

    const left = await findImpByName(ctx.source.db, 'dev');

    const sourceSets = await runChecked([
      'zfs',
      'list',
      '-H',
      '-o',
      'name',
      '-t',
      'all',
      '-r',
      ctx.sourceRoot,
    ]);

    const woken = await ctx.targetApp.client.imps.wake({ name: 'dev' });

    expect(status).toMatchObject({ isDone: true, error: null });

    expect(moved).toMatchObject({
      id: created.id,
      slot: created.slot,
      state: 'sleeping',
      moveState: null,
    });

    expect(created.slot).toBe(1);
    expect(meta).not.toBeNull();
    expect(mem).toBe('mem');
    expect(movedDisk).toStartWith('warm');
    expect(sourceSets).not.toInclude(created.id);
    expect(left).toBeUndefined();
    expect(woken.state).toBe('running');
    expect(ctx.target.fake.wakes).toHaveLength(1);
  },
  180_000,
);
