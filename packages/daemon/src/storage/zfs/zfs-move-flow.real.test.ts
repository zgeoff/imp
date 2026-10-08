import { afterEach, expect, test } from 'bun:test';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createImage } from '../../db/images';
import { findImpByName } from '../../db/imps';
import { setupMoveHosts } from '../../moves/test-moves';
import { runChecked, runCommand } from '../../process/run-command';
import { readSnapshotMeta } from '../../sleep/snapshot-meta';
import { createZfsBackend } from './zfs-backend';
import type { ZfsBackend } from './zfs-backend';

// Whole moves, as `imp move` runs them, between two impds on one real pool,
// as root: the `zfs` CI job runs these through scripts/test-zfs.sh. Skipped
// everywhere else. Only the VMs are fakes.
const POOL_ROOT = process.env['IMP_TEST_ZFS_ROOT'];
const POOL_DIR = process.env['IMP_TEST_ZFS_DIR'];
const isReal = POOL_ROOT !== undefined && POOL_DIR !== undefined;
const cleanups: (() => Promise<void>)[] = [];

// zfs commands on a shared CI runner take seconds each
const REAL_TEST_TIMEOUT_MS = 180_000;
const MOVE_TIMEOUT_MS = 120_000;

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

// one impd's root dataset, mounted as setup-storage.sh mounts one, and its
// backend; the cleanup waits for the backend's reclaim, then destroys it all
async function setupPoolHost(name: string) {
  const root = `${POOL_ROOT ?? ''}/${name}`;
  const dataDir = join(POOL_DIR ?? '', name);

  await runChecked(['zfs', 'create', '-o', 'mountpoint=legacy', root]);

  mkdirSync(dataDir, { recursive: true });

  await runChecked(['mount', '-t', 'zfs', root, dataDir]);

  const made: { backend: ZfsBackend | null } = { backend: null };

  cleanups.push(async () => {
    await made.backend?.waitForReclaim();

    await runCommand(['umount', '-R', dataDir]);
    await runChecked(['zfs', 'destroy', '-R', root]);
  });

  const createStorage = (dir: string): ZfsBackend => {
    made.backend = createZfsBackend({ dataDir: dir, root, log: () => {} });

    return made.backend;
  };

  return { root, options: { dataDir, createStorage } };
}

async function listDatasets(root: string): Promise<string[]> {
  const listed = await runChecked(['zfs', 'list', '-H', '-o', 'name', '-t', 'all', '-r', root]);

  return listed.split('\n').filter((line) => line !== '');
}

// two impds on the pool, each with the `ubuntu` image as a dataset
async function setupPoolMove(options: Readonly<{ isShared?: boolean }> = {}) {
  const stamp = String(Date.now());

  const source = await setupPoolHost(`s${stamp}`);
  const target = await setupPoolHost(`t${stamp}`);

  const hosts = await setupMoveHosts({
    isShared: options.isShared === true,
    source: source.options,
    target: target.options,
    moveTimeoutMs: MOVE_TIMEOUT_MS,
  });

  for (const host of [hosts.source, hosts.target]) {
    await host.storage.start({
      impIds: new Set(),
      checkpointIds: new Set(),
      imageDigests: new Set(),
    });

    await host.storage.createImage('sha256:ubuntu', (dir) => {
      writeSyncedFile(join(dir, 'rootfs.ext4'), 'rootfs');
      writeSyncedFile(join(dir, 'config.json'), '{}');

      return Promise.resolve();
    });

    await createImage(host.db, {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
    });
  }

  return { ...hosts, sourceRoot: source.root, targetRoot: target.root };
}

test.skipIf(!isReal)(
  'a stopped imp moves cold between two ZFS impds with its checkpoint and its disk',
  async () => {
    const ctx = await setupPoolMove();
    const created = await ctx.sourceApp.client.imps.create({ name: 'dev', image: 'ubuntu' });

    await ctx.sourceApp.client.imps.stop({ name: 'dev' });

    const disk = ctx.source.storage.resolveImpPaths(created.id).disk;

    writeSyncedFile(disk, 'hello');

    await ctx.sourceApp.client.checkpoints.create({ name: 'dev', label: 'one' });

    writeSyncedFile(disk, 'world');

    const status = await ctx.runMove('dev');
    const moved = await ctx.targetApp.client.imps.get({ name: 'dev' });
    const checkpoints = await ctx.targetApp.client.checkpoints.list({ name: 'dev' });
    const left = await findImpByName(ctx.source.db, 'dev');

    const movedDisk = readFileSync(ctx.target.storage.resolveImpPaths(created.id).disk, 'utf8');

    const targetSets = await listDatasets(ctx.targetRoot);
    const sourceSets = await listDatasets(ctx.sourceRoot);
    const started = await ctx.targetApp.client.imps.start({ name: 'dev' });

    expect(status).toMatchObject({ isDone: true, error: null });
    expect(moved).toMatchObject({ id: created.id, state: 'stopped' });
    expect(moved.move).toBeUndefined();
    expect(checkpoints.map((checkpoint) => checkpoint.label)).toEqual(['one']);
    expect(movedDisk.startsWith('world')).toBe(true);

    expect(targetSets).toContain(
      `${ctx.targetRoot}/disks/${created.id}@${checkpoints[0]?.id ?? ''}`,
    );

    expect(sourceSets.filter((name) => name.includes(created.id))).toEqual([]);
    expect(left).toBeUndefined();
    expect(started.state).toBe('running');
  },
  REAL_TEST_TIMEOUT_MS,
);

test.skipIf(!isReal)(
  'a sleeping imp moves warm between two ZFS impds into its slot, and wakes from its memory',
  async () => {
    // two impds in one process differ in their data dirs: both report the
    // target's facts, as two hosts with the same IMP_DATA_DIR would
    const ctx = await setupPoolMove({ isShared: true });

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
    const sourceSets = await listDatasets(ctx.sourceRoot);
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
    expect(movedDisk.startsWith('warm')).toBe(true);
    expect(sourceSets.filter((name) => name.includes(created.id))).toEqual([]);
    expect(left).toBeUndefined();
    expect(woken.state).toBe('running');
    expect(ctx.target.fake.wakes).toHaveLength(1);
  },
  REAL_TEST_TIMEOUT_MS,
);
