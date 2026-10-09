import { expect, mock, onTestFinished, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildStubFiemap } from '../test-utils/build-stub-fiemap';
import { readExtents } from './fiemap';
import { createXfsBackend } from './xfs-backend';

interface SetupOptions {
  // where the data dir goes; a temp dir by default
  readonly parentDir?: string;
  readonly reserveFileBytes?: number;
  readonly readFileExtents?: typeof readExtents;
}

async function setupTest(options: SetupOptions = {}) {
  const dataDir = await mkdtemp(join(options.parentDir ?? tmpdir(), 'impd-xfs-test-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  const log = mock<(message: string) => void>();

  const backend = createXfsBackend({
    dataDir,
    log,

    // a temp dir is rarely XFS, so a clone is a copy
    cloneFile: (source, target) => {
      copyFileSync(source, target);

      return Promise.resolve();
    },
    reserveFileBytes: options.reserveFileBytes ?? 0,
    readFileExtents: options.readFileExtents ?? readExtents,
  });

  return { dataDir, backend, log };
}

test('#createImage replaces a directory a crash left with no rootfs', async () => {
  const ctx = await setupTest();

  // what impd before the storage backends left when it died mid-build
  mkdirSync(join(ctx.dataDir, 'images', 'abc'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'images', 'abc', 'config.json'), '{"old":true}');

  await ctx.backend.createImage('sha256:abc', async (dir) => {
    await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
    await Bun.write(join(dir, 'config.json'), '{}');
  });

  expect(readFileSync(join(ctx.dataDir, 'images', 'abc', 'rootfs.ext4'), 'utf8')).toBe('rootfs');
  expect(readFileSync(join(ctx.dataDir, 'images', 'abc', 'config.json'), 'utf8')).toBe('{}');
});

test('#createImage removes its staging dir when the write fails', async () => {
  const ctx = await setupTest();

  const created = ctx.backend.createImage('sha256:abc', async (dir) => {
    await Bun.write(join(dir, 'rootfs.ext4'), 'half');

    throw new Error('the export failed');
  });

  expect(created).rejects.toThrowWithMessage(Error, 'the export failed');
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual([]);
});

test('#createImageFromImp makes a clone of the disk the rootfs of the image', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImpDisk('a', { kind: 'empty' });

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'template disk');

  await ctx.backend.createImageFromImp('sha256:tpl', 'a', {
    hold: (clone) => clone(),
    write: async (dir) => {
      await Bun.write(join(dir, 'config.json'), '{}');
    },
  });

  expect(readFileSync(join(ctx.dataDir, 'images', 'tpl', 'rootfs.ext4'), 'utf8')).toBe(
    'template disk',
  );

  expect(readFileSync(join(ctx.dataDir, 'images', 'tpl', 'config.json'), 'utf8')).toBe('{}');
});

test('#removeImage removes the image directory', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImage('sha256:abc', async (dir) => {
    await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
  });

  await ctx.backend.removeImage('sha256:abc');

  expect(existsSync(join(ctx.dataDir, 'images', 'abc'))).toBeFalse();
});

test('#start removes image builds a crash cut short', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dataDir, 'images', '.new-crashed'), { recursive: true });
  mkdirSync(join(ctx.dataDir, 'images', 'abc'), { recursive: true });

  await ctx.backend.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(['sha256:abc']),
  });

  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual(['abc']);
});

test('#start keeps every imp and image a lost database leaves', async () => {
  const ctx = await setupTest();

  // images abc and old, an image with no rootfs, imps a (cp-1, cp-2, a
  // memory file) and b, and the memory snapshot of an imp with no disk
  for (const digest of ['sha256:abc', 'sha256:old']) {
    await ctx.backend.createImage(digest, async (dir) => {
      await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
    });
  }

  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:old' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createCheckpoint('a', 'cp-2');

  const a = ctx.backend.resolveImpPaths('a');
  const sleeper = ctx.backend.resolveImpPaths('sleeper');

  mkdirSync(dirname(a.memFile), { recursive: true });
  writeFileSync(a.memFile, 'memory');
  mkdirSync(join(ctx.dataDir, 'images', 'half'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'images', 'half', 'config.json'), '{}');
  mkdirSync(sleeper.snapshotDir, { recursive: true });
  writeFileSync(sleeper.vmstate, 'vmstate');

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(readdirSync(join(ctx.dataDir, 'imps'))).toIncludeSameMembers(['a', 'b', 'sleeper']);
  expect(readdirSync(join(ctx.dataDir, 'images'))).toIncludeSameMembers(['abc', 'half', 'old']);
  expect(readdirSync(a.checkpointsDir)).toIncludeSameMembers(['cp-1', 'cp-2']);
  expect(readFileSync(a.memFile, 'utf8')).toBe('memory');
  expect(existsSync(sleeper.vmstate)).toBeTrue();
});

test('#start logs each orphan it keeps and each leftover it removes', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImage('sha256:abc', async (dir) => {
    await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
  });

  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createCheckpoint('a', 'cp-2');

  // empty directories: provably nothing
  mkdirSync(ctx.backend.resolveImpPaths('done').runDir, { recursive: true });
  mkdirSync(join(ctx.dataDir, 'images', 'empty'), { recursive: true });

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  const lines = ctx.log.mock.calls.map(([line]) => line);

  expect(lines).toIncludeAllMembers([
    'impd: storage: removed image empty',
    'impd: storage: removed imp done',
  ]);

  expect(lines).toSatisfyAny((line: string) =>
    /^impd: storage: kept orphan imp a \(.+\/imps\/a\): \d+\.\d MiB, created \d{4}-\d\d-\d\dT.+Z, snapshots: cp-1, cp-2$/.test(
      line,
    ),
  );

  expect(lines).toSatisfyAny((line: string) =>
    line.startsWith('impd: storage: kept orphan image abc '),
  );

  expect(lines.at(-1)).toInclude('kept 2 orphans the database does not name');
});

test('#dropUnnamed removes what is provably nothing and keeps each orphan with its size and age', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImage('sha256:abc', async (dir) => {
    await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
  });

  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createCheckpoint('a', 'cp-1');

  mkdirSync(ctx.backend.resolveImpPaths('done').runDir, { recursive: true });
  mkdirSync(join(ctx.dataDir, 'images', 'empty'), { recursive: true });

  const swept = await ctx.backend.dropUnnamed(
    { impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() },
    { isDryRun: false, isOrphans: false },
  );

  expect(swept).toStrictEqual({
    dropped: [
      { kind: 'image', id: 'empty' },
      { kind: 'imp', id: 'done' },
    ],
    kept: [
      {
        kind: 'image',
        id: 'abc',
        location: join(ctx.dataDir, 'images', 'abc'),
        bytes: expect.toBePositive(),
        createdAt: expect.toBeValidDate(),
        snapshots: [],
      },
      {
        kind: 'imp',
        id: 'a',
        location: join(ctx.dataDir, 'imps', 'a'),
        bytes: expect.toBePositive(),
        createdAt: expect.toBeValidDate(),
        snapshots: ['cp-1'],
      },
    ],
  });

  expect(readdirSync(join(ctx.dataDir, 'imps'))).toStrictEqual(['a']);
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual(['abc']);
});

test('#dropUnnamed lists each orphan as dropped in a dry run with orphans, and removes nothing', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImage('sha256:abc', async (dir) => {
    await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
  });

  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });

  const sleeper = ctx.backend.resolveImpPaths('sleeper');

  mkdirSync(sleeper.snapshotDir, { recursive: true });
  writeFileSync(sleeper.vmstate, 'vmstate');

  const listed = await ctx.backend.dropUnnamed(
    { impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() },
    { isDryRun: true, isOrphans: true },
  );

  expect(listed).toStrictEqual({
    dropped: [
      { kind: 'image', id: 'abc' },
      { kind: 'imp', id: 'a' },
      { kind: 'imp', id: 'sleeper' },
    ],
    kept: [],
  });

  expect(readdirSync(join(ctx.dataDir, 'imps'))).toIncludeSameMembers(['a', 'sleeper']);
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual(['abc']);
});

test('#dropUnnamed removes each orphan when asked for orphans', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImage('sha256:abc', async (dir) => {
    await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
  });

  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });

  const removed = await ctx.backend.dropUnnamed(
    { impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() },
    { isDryRun: false, isOrphans: true },
  );

  expect(removed.dropped).toStrictEqual([
    { kind: 'image', id: 'abc' },
    { kind: 'imp', id: 'a' },
  ]);

  expect(readdirSync(join(ctx.dataDir, 'imps'))).toStrictEqual([]);
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual([]);
});

test('#dropUnnamed keeps the checkpoints and imps an older database does not name', async () => {
  const ctx = await setupTest();

  for (const digest of ['sha256:abc', 'sha256:old']) {
    await ctx.backend.createImage(digest, async (dir) => {
      await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
    });
  }

  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createImpDisk('gone', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createCheckpoint('a', 'cp-new');
  await ctx.backend.createCheckpoint('gone', 'cp-gone');

  // it names a and cp-1, not cp-new
  const swept = await ctx.backend.dropUnnamed(
    {
      impIds: new Set(['a']),
      checkpointIds: new Set(['cp-1']),
      imageDigests: new Set(['sha256:abc']),
    },
    { isDryRun: false, isOrphans: false },
  );

  expect(swept.dropped).toStrictEqual([]);

  expect(swept.kept.map((orphan) => `${orphan.kind} ${orphan.id}`)).toStrictEqual([
    'image old',
    'imp gone',
    'checkpoint cp-new',
  ]);

  expect(readdirSync(join(ctx.dataDir, 'imps'))).toIncludeSameMembers(['a', 'gone']);

  expect(readdirSync(ctx.backend.resolveImpPaths('a').checkpointsDir)).toIncludeSameMembers([
    'cp-1',
    'cp-new',
  ]);
});

test('#dropUnnamed removes what an older database does not name when asked for orphans, and never an image build in flight', async () => {
  const ctx = await setupTest();

  for (const digest of ['sha256:abc', 'sha256:old']) {
    await ctx.backend.createImage(digest, async (dir) => {
      await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
    });
  }

  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createImpDisk('gone', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createCheckpoint('a', 'cp-new');

  // an image build in flight keeps its hidden directory
  mkdirSync(join(ctx.dataDir, 'images', '.build-now'), { recursive: true });

  const removed = await ctx.backend.dropUnnamed(
    {
      impIds: new Set(['a']),
      checkpointIds: new Set(['cp-1']),
      imageDigests: new Set(['sha256:abc']),
    },
    { isDryRun: false, isOrphans: true },
  );

  expect(removed.dropped).toStrictEqual([
    { kind: 'image', id: 'old' },
    { kind: 'imp', id: 'gone' },
    { kind: 'checkpoint', id: 'cp-new' },
  ]);

  expect(readdirSync(join(ctx.dataDir, 'images'))).toIncludeSameMembers(['.build-now', 'abc']);
  expect(readdirSync(join(ctx.dataDir, 'imps'))).toStrictEqual(['a']);
  expect(readdirSync(ctx.backend.resolveImpPaths('a').checkpointsDir)).toStrictEqual(['cp-1']);
});

test('#createImpDisk makes an empty disk a zero-length file', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImpDisk('b', { kind: 'empty' });

  expect(statSync(ctx.backend.resolveImpPaths('b').disk).size).toBe(0);
});

test('#createImpDisk clones the disk of another imp', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImpDisk('a', { kind: 'empty' });

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'disk of a');

  await ctx.backend.createImpDisk('fork', { kind: 'imp', impId: 'a' });

  expect(readFileSync(ctx.backend.resolveImpPaths('fork').disk, 'utf8')).toBe('disk of a');
});

test('#createImpDisk clones a checkpoint of another imp', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImpDisk('a', { kind: 'empty' });

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'at cp-1');

  await ctx.backend.createCheckpoint('a', 'cp-1');

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'since cp-1');

  await ctx.backend.createImpDisk('fork', { kind: 'checkpoint', impId: 'a', checkpointId: 'cp-1' });

  expect(readFileSync(ctx.backend.resolveImpPaths('fork').disk, 'utf8')).toBe('at cp-1');
});

test('#removeImpDisk removes the disk and its checkpoints', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImpDisk('a', { kind: 'empty' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.removeImpDisk('a', ['cp-1']);

  expect(existsSync(ctx.backend.resolveImpPaths('a').disk)).toBeFalse();
  expect(existsSync(ctx.backend.resolveImpPaths('a').checkpointsDir)).toBeFalse();
});

test('#createCheckpoint returns the bytes its clone holds', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImpDisk('a', { kind: 'empty' });

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, Buffer.alloc(65_536, 1));

  const bytes = await ctx.backend.createCheckpoint('a', 'cp-1');

  const clone = join(ctx.backend.resolveImpPaths('a').checkpointsDir, 'cp-1', 'disk.ext4');

  expect(bytes).toBe(statSync(clone).blocks * 512);
});

test('#createCheckpoint removes the half-made checkpoint when its clone fails', async () => {
  const ctx = await setupTest();

  // no disk to clone: the copy fails
  const created = ctx.backend.createCheckpoint('a', 'cp-1');
  const checkpointsDir = ctx.backend.resolveImpPaths('a').checkpointsDir;

  expect(created).rejects.toThrow(/ENOENT/);
  expect(existsSync(join(checkpointsDir, 'cp-1'))).toBeFalse();
});

test('#removeCheckpoint removes the checkpoint and leaves the disk', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImpDisk('a', { kind: 'empty' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.removeCheckpoint('a', 'cp-1');

  const checkpointsDir = ctx.backend.resolveImpPaths('a').checkpointsDir;

  expect(existsSync(join(checkpointsDir, 'cp-1'))).toBeFalse();
  expect(existsSync(ctx.backend.resolveImpPaths('a').disk)).toBeTrue();
});

test('#restoreCheckpoint swaps the checkpoint in once halt returns, and returns what halt did', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImpDisk('a', { kind: 'empty' });

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'at cp-1');

  await ctx.backend.createCheckpoint('a', 'cp-1');

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'since cp-1');

  const seen: string[] = [];

  const halted = await ctx.backend.restoreCheckpoint('a', 'cp-1', () => {
    seen.push(readFileSync(ctx.backend.resolveImpPaths('a').disk, 'utf8'));

    return Promise.resolve('stopped');
  });

  expect(halted).toBe('stopped');
  expect(seen).toStrictEqual(['since cp-1']);
  expect(readFileSync(ctx.backend.resolveImpPaths('a').disk, 'utf8')).toBe('at cp-1');
  expect(existsSync(`${ctx.backend.resolveImpPaths('a').disk}.new`)).toBeFalse();
});

test('#restoreCheckpoint keeps the disk and removes the staged copy when halt fails', async () => {
  const ctx = await setupTest();

  await ctx.backend.createImpDisk('a', { kind: 'empty' });

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'at cp-1');

  await ctx.backend.createCheckpoint('a', 'cp-1');

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'since cp-1');

  const restored = ctx.backend.restoreCheckpoint('a', 'cp-1', () =>
    Promise.reject(new Error('the VM would not stop')),
  );

  expect(restored).rejects.toThrowWithMessage(Error, 'the VM would not stop');
  expect(readFileSync(ctx.backend.resolveImpPaths('a').disk, 'utf8')).toBe('since cp-1');
  expect(existsSync(`${ctx.backend.resolveImpPaths('a').disk}.new`)).toBeFalse();
});

test('#openMoveSource names the disk and the checkpoints a files move sends', async () => {
  const ctx = await setupTest();
  const source = await ctx.backend.openMoveSource('a', ['cp-1', 'cp-2'], 'files');

  expect(source).toStrictEqual({
    kind: 'files',
    checkpointPaths: [
      join(ctx.dataDir, 'imps', 'a', 'checkpoints', 'cp-1', 'disk.ext4'),
      join(ctx.dataDir, 'imps', 'a', 'checkpoints', 'cp-2', 'disk.ext4'),
    ],
    diskPath: join(ctx.dataDir, 'imps', 'a', 'disk.ext4'),
    close: expect.toBeFunction(),
  });
});

test('#openMoveSource refuses a zfs move from an XFS host', async () => {
  const ctx = await setupTest();

  expect(ctx.backend.openMoveSource('a', [], 'zfs')).rejects.toThrowWithMessage(
    Error,
    'xfs: a move from an XFS host sends files',
  );
});

test('#receiveMoveSnapshots refuses ZFS streams on an XFS host', async () => {
  const ctx = await setupTest();

  expect(
    ctx.backend.receiveMoveSnapshots(
      'a',
      [],
      () => new ReadableStream(),
      () => 'cp-1',
    ),
  ).rejects.toThrowWithMessage(Error, 'xfs: only a ZFS host receives ZFS streams');
});

test('#createBackupCopy keeps the copy of an unchanged disk when it may be reused', async () => {
  const ctx = await setupTest();

  const copy = join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'disk', 'rootfs.ext4');

  await ctx.backend.createImpDisk('a', { kind: 'empty' });

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'disk');

  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  const first = statSync(copy).ino;

  await ctx.backend.createBackupCopy('a', 'r2', { isReusable: true });

  expect(statSync(copy).ino).toBe(first);
});

test('#createBackupCopy copies an unchanged disk again when the copy may not be reused', async () => {
  const ctx = await setupTest();

  const copy = join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'disk', 'rootfs.ext4');

  await ctx.backend.createImpDisk('a', { kind: 'empty' });

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'disk');

  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  const first = statSync(copy).ino;

  await ctx.backend.createBackupCopy('a', 'r2', { isReusable: false });

  expect(statSync(copy).ino).not.toBe(first);
});

test('#createBackupCopy copies a disk written since its last copy', async () => {
  const ctx = await setupTest();

  const copy = join(ctx.dataDir, 'backup', 'tree', 'imps', 'a', 'disk', 'rootfs.ext4');

  await ctx.backend.createImpDisk('a', { kind: 'empty' });

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'disk');

  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'written');

  await ctx.backend.createBackupCopy('a', 'r2', { isReusable: true });

  expect(readFileSync(copy, 'utf8')).toBe('written');
});

test('#openBackupTree clones the checkpoints and images it names and drops what is gone', async () => {
  const ctx = await setupTest();

  const tree = join(ctx.dataDir, 'backup', 'tree');

  await ctx.backend.createImage('sha256:abc', async (dir) => {
    await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
    await Bun.write(join(dir, 'config.json'), '{}');
  });

  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  mkdirSync(join(tree, 'imps', 'destroyed', 'disk'), { recursive: true });

  const opened = await ctx.backend.openBackupTree({
    runId: 'r1',
    imps: [
      { impId: 'a', checkpointIds: ['cp-1', 'cp-deleted'] },
      { impId: 'never-copied', checkpointIds: [] },
    ],
    imageDigests: ['sha256:abc', 'sha256:removed'],
  });

  expect(opened.impIds).toStrictEqual(new Set(['a']));
  expect(opened.checkpointIds).toStrictEqual(new Set(['cp-1']));
  expect(opened.imageDigests).toStrictEqual(new Set(['sha256:abc']));
  expect(readdirSync(join(tree, 'imps'))).toStrictEqual(['a']);
  expect(readFileSync(join(tree, 'images', 'abc', 'rootfs.ext4'), 'utf8')).toBe('rootfs');
  expect(existsSync(join(tree, 'imps', 'a', 'checkpoints', 'cp-1', 'rootfs.ext4'))).toBeTrue();
});

test('#openBackupTree keeps a clone it made in an earlier run, and drops an image no longer named', async () => {
  const ctx = await setupTest();

  const tree = join(ctx.dataDir, 'backup', 'tree');
  const checkpoint = join(tree, 'imps', 'a', 'checkpoints', 'cp-1', 'rootfs.ext4');

  await ctx.backend.createImage('sha256:abc', async (dir) => {
    await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
    await Bun.write(join(dir, 'config.json'), '{}');
  });

  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  const earlier = await ctx.backend.openBackupTree({
    runId: 'r1',
    imps: [{ impId: 'a', checkpointIds: ['cp-1'] }],
    imageDigests: ['sha256:abc'],
  });

  await earlier.close();

  const first = statSync(checkpoint).ino;

  await ctx.backend.openBackupTree({
    runId: 'r2',
    imps: [{ impId: 'a', checkpointIds: ['cp-1'] }],
    imageDigests: [],
  });

  expect(statSync(checkpoint).ino).toBe(first);
  expect(readdirSync(join(tree, 'images'))).toStrictEqual([]);
});

test("#openBackupTree removes a running disk's copy when it closes, and keeps a reusable one", async () => {
  const ctx = await setupTest();

  const tree = join(ctx.dataDir, 'backup', 'tree');

  await ctx.backend.createImpDisk('a', { kind: 'empty' });
  await ctx.backend.createImpDisk('b', { kind: 'empty' });
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: false });
  await ctx.backend.createBackupCopy('b', 'r1', { isReusable: true });

  const opened = await ctx.backend.openBackupTree({
    runId: 'r1',
    imps: [
      { impId: 'a', checkpointIds: [] },
      { impId: 'b', checkpointIds: [] },
    ],
    imageDigests: [],
  });

  const whileOpen = existsSync(join(tree, 'imps', 'a', 'disk', 'rootfs.ext4'));

  await opened.close();

  expect(whileOpen).toBeTrue();
  expect(existsSync(join(tree, 'imps', 'a', 'disk', 'rootfs.ext4'))).toBeFalse();
  expect(existsSync(join(tree, 'imps', 'b', 'disk', 'rootfs.ext4'))).toBeTrue();
});

test('#start allocates the reserve file', async () => {
  const ctx = await setupTest({ reserveFileBytes: 65_536 });

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(statSync(join(ctx.dataDir, 'reserve')).blocks * 512).toBeGreaterThanOrEqual(65_536);
});

test('#start allocates the reserve file again after someone removed it', async () => {
  const ctx = await setupTest({ reserveFileBytes: 65_536 });

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  await rm(join(ctx.dataDir, 'reserve'));

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(existsSync(join(ctx.dataDir, 'reserve'))).toBeTrue();
});

test('#start logs and skips a reserve file that would take more than half the free space', async () => {
  const ctx = await setupTest({ reserveFileBytes: Number.MAX_SAFE_INTEGER });

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(existsSync(join(ctx.dataDir, 'reserve'))).toBeFalse();

  expect(ctx.log).toHaveBeenCalledWith(
    `impd: xfs: too little free space for the ${String(Number.MAX_SAFE_INTEGER)}-byte reserve file`,
  );
});

test('#measureUsage counts the blocks of each imp and its checkpoints through FIEMAP', async () => {
  // FIEMAP needs a real filesystem, which a tmpfs temp dir is not: the
  // checkout's own ignored .cache is one
  const parentDir = join(import.meta.dir, '..', '..', '..', '..', '.cache');

  mkdirSync(parentDir, { recursive: true });

  const ctx = await setupTest({ parentDir });

  await ctx.backend.createImage('sha256:abc', async (dir) => {
    await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
  });

  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:abc' });

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, Buffer.alloc(1_048_576, 1));

  await ctx.backend.createCheckpoint('a', 'cp-1');

  const report = await ctx.backend.measureUsage([
    { impId: 'a', checkpointIds: ['cp-1'] },
    { impId: 'b', checkpointIds: [] },
  ]);

  // copies here, so nothing is shared; the disk and its checkpoint are 1 MiB
  // each, and b's copy of the image takes what its filesystem allocated
  expect(report.isPartial).toBeFalse();

  expect(report.imps.get('a')).toStrictEqual({
    exclusiveBytes: 2_097_152,
    sharedBytes: 0,
    isUpperBound: false,
  });

  expect(report.imps.get('b')).toStrictEqual({
    exclusiveBytes: statSync(ctx.backend.resolveImpPaths('b').disk).blocks * 512,
    sharedBytes: 0,
    isUpperBound: false,
  });
});

test('#measureUsage leaves out the imp a pass cut short at, and the imps after it', async () => {
  const fiemap = buildStubFiemap();

  const ctx = await setupTest({ readFileExtents: fiemap.readFileExtents });

  await ctx.backend.createImage('sha256:abc', async (dir) => {
    await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
  });

  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createImpDisk('c', { kind: 'image', digest: 'sha256:abc' });

  fiemap.setCut(ctx.backend.resolveImpPaths('b').disk, true);

  const report = await ctx.backend.measureUsage([
    { impId: 'a', checkpointIds: [] },
    { impId: 'b', checkpointIds: [] },
    { impId: 'c', checkpointIds: [] },
  ]);

  expect(fiemap.reads).toStrictEqual([
    join(ctx.dataDir, 'images', 'abc', 'rootfs.ext4'),
    ctx.backend.resolveImpPaths('a').disk,
    ctx.backend.resolveImpPaths('b').disk,
  ]);

  expect(report.isPartial).toBeTrue();
  expect([...report.imps.keys()]).toStrictEqual(['a']);
});

test('#measureUsage starts the next pass at the imp the last one cut short at', async () => {
  const fiemap = buildStubFiemap();

  const ctx = await setupTest({ readFileExtents: fiemap.readFileExtents });

  await ctx.backend.createImage('sha256:abc', async (dir) => {
    await Bun.write(join(dir, 'rootfs.ext4'), 'rootfs');
  });

  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createImpDisk('c', { kind: 'image', digest: 'sha256:abc' });

  fiemap.setCut(ctx.backend.resolveImpPaths('b').disk, true);

  const imps = [
    { impId: 'a', checkpointIds: [] },
    { impId: 'b', checkpointIds: [] },
    { impId: 'c', checkpointIds: [] },
  ];

  await ctx.backend.measureUsage(imps);

  fiemap.setCut(ctx.backend.resolveImpPaths('b').disk, false);

  fiemap.reads.length = 0;

  const report = await ctx.backend.measureUsage(imps);

  expect(fiemap.reads).toStrictEqual([
    join(ctx.dataDir, 'images', 'abc', 'rootfs.ext4'),
    ctx.backend.resolveImpPaths('b').disk,
    ctx.backend.resolveImpPaths('c').disk,
    ctx.backend.resolveImpPaths('a').disk,
  ]);

  expect(report.isPartial).toBeFalse();
  expect([...report.imps.keys()]).toStrictEqual(['b', 'c', 'a']);
});

test('#measureUsage fails on a file that FIEMAP cannot read and that is still there', async () => {
  const fiemap = buildStubFiemap();

  const ctx = await setupTest({ readFileExtents: fiemap.readFileExtents });

  await ctx.backend.createImpDisk('a', { kind: 'empty' });

  fiemap.failAt(ctx.backend.resolveImpPaths('a').disk, new Error('EIO: i/o error'));

  expect(ctx.backend.measureUsage([{ impId: 'a', checkpointIds: [] }])).rejects.toThrowWithMessage(
    Error,
    'EIO: i/o error',
  );
});

test('#readUsage reports the used and available bytes of the data dir', async () => {
  const ctx = await setupTest();
  const usage = await ctx.backend.readUsage();

  const stats = statfsSync(ctx.dataDir);

  // other writers share the temp dir's filesystem, so its counts may move a little
  expect(usage.usedBytes).toBeWithin(
    (stats.blocks - stats.bfree) * stats.bsize - 64 * 1024 ** 2,
    (stats.blocks - stats.bfree) * stats.bsize + 64 * 1024 ** 2,
  );

  expect(usage.availableBytes).toBeWithin(
    stats.bavail * stats.bsize - 64 * 1024 ** 2,
    stats.bavail * stats.bsize + 64 * 1024 ** 2,
  );
});
