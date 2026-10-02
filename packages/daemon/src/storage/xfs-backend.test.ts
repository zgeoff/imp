import { expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readExtents } from './fiemap';
import { createXfsBackend } from './xfs-backend';

function setupTest(parentDir = tmpdir()) {
  const dataDir = mkdtempSync(`${parentDir}/impd-xfs-test-`);
  const logs: string[] = [];

  return {
    dataDir,
    logs,
    backend: createXfsBackend({
      dataDir,
      log: (message) => {
        logs.push(message);
      },

      // tmpdir is rarely XFS
      cloneFile: (source, target) => {
        copyFileSync(source, target);

        return Promise.resolve();
      },
    }),
    imageDir: join(dataDir, 'images', 'abc'),
    [Symbol.dispose]: () => {
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function writeImage(dir: string): Promise<void> {
  writeFileSync(join(dir, 'rootfs.ext4'), 'rootfs');
  writeFileSync(join(dir, 'config.json'), '{}');

  return Promise.resolve();
}

test('an image replaces a directory a crash left with no rootfs', async () => {
  using ctx = setupTest();

  // what impd before the storage backends left when it died mid-build
  mkdirSync(ctx.imageDir, { recursive: true });
  writeFileSync(join(ctx.imageDir, 'config.json'), '{"old":true}');

  await ctx.backend.createImage('sha256:abc', writeImage);

  expect(readFileSync(join(ctx.imageDir, 'rootfs.ext4'), 'utf8')).toBe('rootfs');
  expect(readFileSync(join(ctx.imageDir, 'config.json'), 'utf8')).toBe('{}');
});

test('start sweeps image builds a crash cut short', async () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dataDir, 'images', '.new-crashed'), { recursive: true });
  mkdirSync(ctx.imageDir, { recursive: true });

  await ctx.backend.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(['sha256:abc']),
  });

  expect(readdirSync(join(ctx.dataDir, 'images'))).toEqual(['abc']);
  expect(existsSync(ctx.imageDir)).toBeTrue();
});

const NO_ROWS = {
  impIds: new Set<string>(),
  checkpointIds: new Set<string>(),
  imageDigests: new Set<string>(),
};

// What a lost database leaves: images abc and old, an image with no rootfs,
// imps a (cp-1, cp-2, a memory file) and b, and the memory snapshot of an
// imp with no disk
async function setupSurvivors() {
  const ctx = setupTest();

  await ctx.backend.createImage('sha256:abc', writeImage);
  await ctx.backend.createImage('sha256:old', writeImage);
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:old' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createCheckpoint('a', 'cp-2');

  const memFile = ctx.backend.resolveImpPaths('a').memFile;

  mkdirSync(dirname(memFile), { recursive: true });
  writeFileSync(memFile, 'memory');
  mkdirSync(join(ctx.dataDir, 'images', 'half'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'images', 'half', 'config.json'), '{}');

  const sleeper = ctx.backend.resolveImpPaths('sleeper');

  mkdirSync(sleeper.snapshotDir, { recursive: true });
  writeFileSync(sleeper.vmstate, 'vmstate');
  writeFileSync(sleeper.snapshotMeta, '{}');

  // empty directories: provably nothing
  mkdirSync(join(ctx.backend.resolveImpPaths('done').runDir), { recursive: true });
  mkdirSync(join(ctx.dataDir, 'images', 'empty'), { recursive: true });

  return ctx;
}

function listTree(dataDir: string): string[] {
  return readdirSync(dataDir, { recursive: true, encoding: 'utf8' }).toSorted();
}

test('start keeps every imp and image a lost database leaves, and logs each', async () => {
  using ctx = await setupSurvivors();

  await ctx.backend.start(NO_ROWS);

  expect(readdirSync(join(ctx.dataDir, 'imps')).toSorted()).toEqual(['a', 'b', 'sleeper']);
  expect(readdirSync(join(ctx.dataDir, 'images')).toSorted()).toEqual(['abc', 'half', 'old']);
  expect(existsSync(ctx.backend.resolveImpPaths('sleeper').vmstate)).toBeTrue();

  expect(readdirSync(ctx.backend.resolveImpPaths('a').checkpointsDir).toSorted()).toEqual([
    'cp-1',
    'cp-2',
  ]);

  expect(readFileSync(ctx.backend.resolveImpPaths('a').memFile, 'utf8')).toBe('memory');

  const kept = ctx.logs.filter((line) => line.startsWith('impd: storage: kept orphan'));

  expect(kept).toHaveLength(6);

  expect(kept.find((line) => line.includes('orphan imp a '))).toMatch(
    /^impd: storage: kept orphan imp a \(.+\/imps\/a\): \d+\.\d MiB, created \d{4}-\d\d-\d\dT.+Z, snapshots: cp-1, cp-2$/,
  );

  expect(ctx.logs).toContain('impd: storage: removed image empty');
  expect(ctx.logs).toContain('impd: storage: removed imp done');
  expect(ctx.logs.at(-1)).toContain('kept 6 orphans the database does not name');
});

test('a sweep keeps the orphans, a dry run with orphans lists them, and orphans removes them', async () => {
  using ctx = await setupSurvivors();

  const before = listTree(ctx.dataDir);

  const swept = await ctx.backend.dropUnnamed(NO_ROWS, { isDryRun: false, isOrphans: false });

  expect(swept.dropped).toEqual([
    { kind: 'image', id: 'empty' },
    { kind: 'imp', id: 'done' },
  ]);

  expect(swept.kept.map((orphan) => [orphan.kind, orphan.id, orphan.snapshots])).toEqual([
    ['image', 'abc', []],
    ['image', 'half', []],
    ['image', 'old', []],
    ['imp', 'a', ['cp-1', 'cp-2']],
    ['imp', 'b', []],
    ['imp', 'sleeper', []],
  ]);

  expect(swept.kept.every((orphan) => orphan.bytes > 0 && orphan.createdAt !== null)).toBeTrue();

  const kept = listTree(ctx.dataDir);

  expect(kept).toEqual(before.filter((path) => !/^(?:imps\/done|images\/empty)/.test(path)));

  const listed = await ctx.backend.dropUnnamed(NO_ROWS, { isDryRun: true, isOrphans: true });

  expect(listed).toEqual({
    dropped: [
      { kind: 'image', id: 'abc' },
      { kind: 'image', id: 'half' },
      { kind: 'image', id: 'old' },
      { kind: 'imp', id: 'a' },
      { kind: 'imp', id: 'b' },
      { kind: 'imp', id: 'sleeper' },
    ],
    kept: [],
  });

  expect(listTree(ctx.dataDir)).toEqual(kept);

  const removed = await ctx.backend.dropUnnamed(NO_ROWS, { isDryRun: false, isOrphans: true });

  expect(removed).toEqual(listed);
  expect(readdirSync(join(ctx.dataDir, 'imps'))).toEqual([]);
  expect(readdirSync(join(ctx.dataDir, 'images'))).toEqual([]);
});

test('dropUnnamed removes the checkpoints of a named imp, and keeps the imps no row names', async () => {
  using ctx = setupTest();

  await ctx.backend.createImage('sha256:abc', writeImage);
  await ctx.backend.createImage('sha256:old', writeImage);
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createImpDisk('gone', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createCheckpoint('a', 'cp-1');
  await ctx.backend.createCheckpoint('a', 'cp-lost');
  await ctx.backend.createCheckpoint('gone', 'cp-gone');

  // an image build in flight keeps its hidden directory
  mkdirSync(join(ctx.dataDir, 'images', '.build-now'), { recursive: true });

  const live = {
    impIds: new Set(['a']),
    checkpointIds: new Set(['cp-1']),
    imageDigests: new Set(['sha256:abc']),
  };

  const listed = await ctx.backend.dropUnnamed(live, { isDryRun: true, isOrphans: false });

  expect(listed.dropped).toEqual([{ kind: 'checkpoint', id: 'cp-lost' }]);
  expect(listed.kept.map((orphan) => orphan.id)).toEqual(['old', 'gone']);

  const lostCheckpoint = join(ctx.backend.resolveImpPaths('a').checkpointsDir, 'cp-lost');

  expect(existsSync(lostCheckpoint)).toBeTrue();

  const dropped = await ctx.backend.dropUnnamed(live, { isDryRun: false, isOrphans: false });

  expect(dropped).toEqual(listed);
  expect(readdirSync(join(ctx.dataDir, 'images')).toSorted()).toEqual(['.build-now', 'abc', 'old']);
  expect(readdirSync(join(ctx.dataDir, 'imps')).toSorted()).toEqual(['a', 'gone']);
  expect(readdirSync(ctx.backend.resolveImpPaths('a').checkpointsDir)).toEqual(['cp-1']);
  expect(readdirSync(ctx.backend.resolveImpPaths('gone').checkpointsDir)).toEqual(['cp-gone']);
});

// imp a cloned from the image, with checkpoint cp-1
async function setupBackupTest() {
  const ctx = setupTest();

  await ctx.backend.createImage('sha256:abc', writeImage);
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createCheckpoint('a', 'cp-1');

  return { ...ctx, treeDir: join(ctx.dataDir, 'backup', 'tree') };
}

test('a backup copy of an unchanged disk is kept only when it may be reused', async () => {
  using ctx = await setupBackupTest();

  const treeDisk = join(ctx.treeDir, 'imps', 'a', 'disk', 'rootfs.ext4');

  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  const first = statSync(treeDisk).ino;

  await ctx.backend.createBackupCopy('a', 'r2', { isReusable: true });

  expect(statSync(treeDisk).ino).toBe(first);

  await ctx.backend.createBackupCopy('a', 'r3', { isReusable: false });

  const recopied = statSync(treeDisk).ino;

  expect(recopied).not.toBe(first);

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, 'written');

  await ctx.backend.createBackupCopy('a', 'r4', { isReusable: true });

  expect(readFileSync(treeDisk, 'utf8')).toBe('written');
});

test('a backup tree clones checkpoints and images once and drops what is gone', async () => {
  using ctx = await setupBackupTest();

  const treeDir = ctx.treeDir;

  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: true });

  mkdirSync(join(treeDir, 'imps', 'destroyed', 'disk'), { recursive: true });

  const tree = await ctx.backend.openBackupTree({
    runId: 'r1',
    imps: [
      { impId: 'a', checkpointIds: ['cp-1', 'cp-deleted'] },
      { impId: 'never-copied', checkpointIds: [] },
    ],
    imageDigests: ['sha256:abc', 'sha256:removed'],
  });

  expect([...tree.impIds]).toEqual(['a']);
  expect([...tree.checkpointIds]).toEqual(['cp-1']);
  expect([...tree.imageDigests]).toEqual(['sha256:abc']);
  expect(readdirSync(join(treeDir, 'imps'))).toEqual(['a']);
  expect(readFileSync(join(treeDir, 'images', 'abc', 'rootfs.ext4'), 'utf8')).toBe('rootfs');

  const checkpoint = join(treeDir, 'imps', 'a', 'checkpoints', 'cp-1', 'rootfs.ext4');
  const first = statSync(checkpoint).ino;

  await tree.close();

  await ctx.backend.openBackupTree({
    runId: 'r2',
    imps: [{ impId: 'a', checkpointIds: ['cp-1'] }],
    imageDigests: [],
  });

  expect(statSync(checkpoint).ino).toBe(first);
  expect(existsSync(join(treeDir, 'images'))).toBeTrue();
  expect(readdirSync(join(treeDir, 'images'))).toEqual([]);
});

test('an empty disk is a zero-length file', async () => {
  using ctx = setupTest();

  await ctx.backend.createImpDisk('b', { kind: 'empty' });

  expect(statSync(ctx.backend.resolveImpPaths('b').disk).size).toBe(0);
});

test("a running disk's copy goes when the tree closes; a reusable one stays", async () => {
  using ctx = await setupBackupTest();

  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createBackupCopy('a', 'r1', { isReusable: false });
  await ctx.backend.createBackupCopy('b', 'r1', { isReusable: true });

  const tree = await ctx.backend.openBackupTree({
    runId: 'r1',
    imps: [
      { impId: 'a', checkpointIds: [] },
      { impId: 'b', checkpointIds: [] },
    ],
    imageDigests: [],
  });

  const running = join(ctx.treeDir, 'imps', 'a', 'disk', 'rootfs.ext4');
  const stopped = join(ctx.treeDir, 'imps', 'b', 'disk', 'rootfs.ext4');

  expect([...tree.impIds].toSorted()).toEqual(['a', 'b']);
  expect(existsSync(running)).toBeTrue();

  await tree.close();

  expect(existsSync(running)).toBeFalse();
  expect(existsSync(stopped)).toBeTrue();
});

test('start allocates the reserve file once, and again after it was removed', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-xfs-test-`);
  const reserve = join(dataDir, 'reserve');

  const live = {
    impIds: new Set<string>(),
    checkpointIds: new Set<string>(),
    imageDigests: new Set<string>(),
  };

  try {
    const backend = createXfsBackend({ dataDir, reserveFileBytes: 65_536, log: () => {} });

    await backend.start(live);

    expect(statSync(reserve).blocks * 512).toBeGreaterThanOrEqual(65_536);

    rmSync(reserve);

    await backend.start(live);

    expect(existsSync(reserve)).toBeTrue();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// tmpfs has no FIEMAP; the checkout's own filesystem usually does
const USAGE_DIR = join(import.meta.dir, '../../../../.cache');

mkdirSync(USAGE_DIR, { recursive: true });

const hasFiemap = await readExtents(import.meta.path, Number.POSITIVE_INFINITY).then(
  () => true,
  () => false,
);

test.skipIf(!hasFiemap)('usage counts the blocks of each imp and its checkpoints', async () => {
  using ctx = setupTest(USAGE_DIR);

  mkdirSync(ctx.imageDir, { recursive: true });

  await ctx.backend.createImage('sha256:abc', writeImage);
  await ctx.backend.createImpDisk('a', { kind: 'image', digest: 'sha256:abc' });
  await ctx.backend.createImpDisk('b', { kind: 'image', digest: 'sha256:abc' });

  writeFileSync(ctx.backend.resolveImpPaths('a').disk, Buffer.alloc(1_048_576, 1));

  await ctx.backend.createCheckpoint('a', 'cp-1');

  const report = await ctx.backend.measureUsage([
    { impId: 'a', checkpointIds: ['cp-1'] },
    { impId: 'b', checkpointIds: [] },
  ]);

  // copies here, so nothing is shared; the disk and its checkpoint are 1 MiB each
  expect(report.isPartial).toBeFalse();

  expect(report.imps.get('a')).toEqual({
    exclusiveBytes: 2 * 1_048_576,
    sharedBytes: 0,
    isUpperBound: false,
  });

  expect(report.imps.get('b')?.exclusiveBytes).toBe(4096);
});

test('a pass cut short leaves out the imp it stopped at, and the next starts there', async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-xfs-test-`);
  const read: string[] = [];
  const state = { cutAt: 'b' as string | null };

  const backend = createXfsBackend({
    dataDir,
    cloneFile: (source, target) => {
      copyFileSync(source, target);

      return Promise.resolve();
    },
    readFileExtents: (path) => {
      const owner = path.includes('/imps/')
        ? (path.split('/imps/')[1]?.split('/')[0] ?? '')
        : 'image';

      read.push(owner);

      const isCut = owner === state.cutAt;
      const extent = { logical: 0, physical: read.length * 4096, length: 4096, flags: 1 };

      return Promise.resolve({ extents: [extent], isComplete: !isCut });
    },
  });

  try {
    mkdirSync(join(dataDir, 'images', 'abc'), { recursive: true });

    await backend.createImage('sha256:abc', writeImage);

    for (const impId of ['a', 'b', 'c']) {
      await backend.createImpDisk(impId, { kind: 'image', digest: 'sha256:abc' });
    }

    const imps = ['a', 'b', 'c'].map((impId) => ({ impId, checkpointIds: [] }));

    const first = await backend.measureUsage(imps);

    expect(read).toEqual(['image', 'a', 'b']);
    expect(first.isPartial).toBeTrue();
    expect([...first.imps.keys()]).toEqual(['a']);

    read.length = 0;
    state.cutAt = null;

    const second = await backend.measureUsage(imps);

    expect(read).toEqual(['image', 'b', 'c', 'a']);
    expect(second.isPartial).toBeFalse();
    expect([...second.imps.keys()]).toEqual(['b', 'c', 'a']);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
