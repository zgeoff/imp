import { afterEach, expect, test } from 'bun:test';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { writeChangedBlocks } from '../../backup/write-changed-blocks';
import { runChecked, runCommand } from '../../process/run-command';
import type { MoveSource } from '../storage-backend';
import { createZfsBackend } from './zfs-backend';
import type { ZfsBackend } from './zfs-backend';

// Moves between two impds on one real pool, as root: the `zfs` CI job runs
// these through scripts/test-zfs.sh. Skipped everywhere else.
const POOL_ROOT = process.env['IMP_TEST_ZFS_ROOT'];
const POOL_DIR = process.env['IMP_TEST_ZFS_DIR'];
const DIGEST = 'sha256:real';
const isReal = POOL_ROOT !== undefined && POOL_DIR !== undefined;
const cleanups: (() => Promise<void>)[] = [];

// zfs commands on a shared CI runner take seconds each
const REAL_TEST_TIMEOUT_MS = 180_000;

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

// one impd's root dataset, mounted as setup-storage.sh mounts one, with the
// image in place
async function setupHost(name: string): Promise<ZfsBackend> {
  const root = `${POOL_ROOT ?? ''}/${name}`;
  const dataDir = join(POOL_DIR ?? '', name);

  await runChecked(['zfs', 'create', '-o', 'mountpoint=legacy', root]);

  mkdirSync(dataDir, { recursive: true });

  await runChecked(['mount', '-t', 'zfs', root, dataDir]);

  const backend = createZfsBackend({ dataDir, root, log: () => {} });

  cleanups.push(async () => {
    await backend.waitForReclaim();

    await runCommand(['umount', '-R', dataDir]);
    await runChecked(['zfs', 'destroy', '-R', root]);
  });

  await backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  await backend.createImage(DIGEST, (dir) => {
    writeSyncedFile(join(dir, 'rootfs.ext4'), 'image');

    return Promise.resolve();
  });

  return backend;
}

async function setupHosts() {
  const stamp = String(Date.now());

  return { source: await setupHost(`s${stamp}`), target: await setupHost(`t${stamp}`) };
}

async function readMoveFiles(source: MoveSource): Promise<string[]> {
  try {
    if (source.kind !== 'files') {
      throw new Error('expected files');
    }

    return [...source.checkpointPaths, source.diskPath].map((path) => readFileSync(path, 'utf8'));
  } finally {
    await source.close();
  }
}

test.skipIf(!isReal)(
  'a restored imp moves to another ZFS host with every checkpoint and its disk',
  async () => {
    const hosts = await setupHosts();

    const disk = hosts.source.resolveImpPaths('a').disk;

    await hosts.source.createImpDisk('a', { kind: 'image', digest: DIGEST });

    writeSyncedFile(disk, 'one');

    await hosts.source.createCheckpoint('a', 'cp-one');

    writeSyncedFile(disk, 'two');

    await hosts.source.createCheckpoint('a', 'cp-two');
    await hosts.source.restoreCheckpoint('a', 'cp-one', () => Promise.resolve());

    writeSyncedFile(disk, 'three');

    await hosts.source.createCheckpoint('a', 'cp-three');

    writeSyncedFile(disk, 'four');

    const source = await hosts.source.openMoveSource('a', ['cp-one', 'cp-two', 'cp-three'], 'zfs');

    const steps = source.kind === 'zfs' ? source.steps : [];
    const ids = ['cp-new1', 'cp-new2', 'cp-new3'];

    const received = await hosts.target.receiveMoveSnapshots(
      'a',
      steps.map((step) => ({
        isCheckpoint: step.checkpointId !== null,
        dataset: step.dataset,
        base: step.base,
      })),
      (index) => steps[index]?.open().stdout ?? new ReadableStream(),
      () => ids.shift() ?? 'cp-none',
    );

    await source.close();

    const ordered = received.map((checkpoint) => checkpoint.id);

    const files = await hosts.target.openMoveSource('a', ordered, 'files');
    const texts = await readMoveFiles(files);

    expect(steps.map((step) => step.base)).toEqual([null, 0, 0, 2]);
    expect(texts).toEqual(['one', 'two', 'three', 'four']);
  },
  REAL_TEST_TIMEOUT_MS,
);

test.skipIf(!isReal)(
  'a move from XFS lands on ZFS as a disk written block by block, checkpoints as snapshots',
  async () => {
    const hosts = await setupHosts();

    const disk = hosts.target.resolveImpPaths('a').disk;
    const temp = join(POOL_DIR ?? '', `incoming-${String(Date.now())}`);

    await hosts.target.createImpDisk('a', { kind: 'empty' });

    // as the receiver does: each file into a temp file, then over the disk
    for (const [index, text] of ['one', 'two'].entries()) {
      writeSyncedFile(temp, text);

      await writeChangedBlocks(temp, disk);

      await hosts.target.createCheckpoint('a', `cp-x${String(index)}`);
    }

    writeSyncedFile(temp, 'three');

    await writeChangedBlocks(temp, disk);

    const files = await hosts.target.openMoveSource('a', ['cp-x0', 'cp-x1'], 'files');
    const texts = await readMoveFiles(files);

    expect(texts).toEqual(['one', 'two', 'three']);
  },
  REAL_TEST_TIMEOUT_MS,
);
