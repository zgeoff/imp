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
import { join } from 'node:path';
import { createXfsBackend } from './xfs-backend';

function setupTest() {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-xfs-test-`);

  return {
    dataDir,
    backend: createXfsBackend({
      dataDir,

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

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(readdirSync(join(ctx.dataDir, 'images'))).toEqual(['abc']);
  expect(existsSync(ctx.imageDir)).toBeTrue();
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
