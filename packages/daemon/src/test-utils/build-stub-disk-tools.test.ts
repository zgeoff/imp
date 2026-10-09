import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubDiskTools } from './build-stub-disk-tools';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'stub-disk-tools-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it copies the source to the target on a clone', async () => {
  const ctx = setupTest();
  const tools = buildStubDiskTools();

  writeFileSync(join(ctx.dir, 'rootfs.ext4'), 'rootfs');

  await tools.cloneDisk(join(ctx.dir, 'rootfs.ext4'), join(ctx.dir, 'disk.ext4'));

  expect(readFileSync(join(ctx.dir, 'disk.ext4'), 'utf8')).toBe('rootfs');
});

test('it records each finished clone by its target', async () => {
  const ctx = setupTest();
  const tools = buildStubDiskTools();

  writeFileSync(join(ctx.dir, 'rootfs.ext4'), 'rootfs');

  await tools.cloneDisk(join(ctx.dir, 'rootfs.ext4'), join(ctx.dir, 'disk.ext4'));

  expect(tools.clones).toStrictEqual([join(ctx.dir, 'disk.ext4')]);
});

test('it fails a clone while clones are set to fail, and writes nothing', () => {
  const ctx = setupTest();
  const tools = buildStubDiskTools();

  writeFileSync(join(ctx.dir, 'rootfs.ext4'), 'rootfs');

  tools.setCloneFailing(true);

  const cloning = tools.cloneDisk(join(ctx.dir, 'rootfs.ext4'), join(ctx.dir, 'disk.ext4'));

  expect(cloning).rejects.toThrowWithMessage(Error, 'clone failed: no space');
  expect(existsSync(join(ctx.dir, 'disk.ext4'))).toBeFalse();
});

test('it clones again once clones are set back from failing', async () => {
  const ctx = setupTest();
  const tools = buildStubDiskTools();

  writeFileSync(join(ctx.dir, 'rootfs.ext4'), 'rootfs');

  tools.setCloneFailing(true);
  tools.setCloneFailing(false);

  await tools.cloneDisk(join(ctx.dir, 'rootfs.ext4'), join(ctx.dir, 'disk.ext4'));

  expect(existsSync(join(ctx.dir, 'disk.ext4'))).toBeTrue();
});

test('it lands no file from a clone while clones are set to land empty', async () => {
  const ctx = setupTest();
  const tools = buildStubDiskTools();

  writeFileSync(join(ctx.dir, 'rootfs.ext4'), 'rootfs');

  tools.setCloneEmpty(true);

  await tools.cloneDisk(join(ctx.dir, 'rootfs.ext4'), join(ctx.dir, 'disk.ext4'));

  expect(existsSync(join(ctx.dir, 'disk.ext4'))).toBeFalse();
});

test('it reports a grown filesystem and records the disk', async () => {
  const tools = buildStubDiskTools();

  const isGrown = await tools.growFilesystem('/imps/a/disk.ext4');

  expect(isGrown).toBeTrue();
  expect(tools.grows).toStrictEqual(['/imps/a/disk.ext4']);
});

test('it holds a clone until the test releases it', async () => {
  const ctx = setupTest();
  const tools = buildStubDiskTools();

  writeFileSync(join(ctx.dir, 'rootfs.ext4'), 'rootfs');

  const held = tools.holdClone();
  const cloning = tools.cloneDisk(join(ctx.dir, 'rootfs.ext4'), join(ctx.dir, 'disk.ext4'));

  await held.reached;

  const whileHeld = Bun.peek.status(cloning);

  held.release();

  await cloning;

  expect(whileHeld).toBe('pending');
  expect(tools.clones).toStrictEqual([join(ctx.dir, 'disk.ext4')]);
});

test('it holds a grow until the test releases it', async () => {
  const tools = buildStubDiskTools();
  const held = tools.holdGrow();
  const growing = tools.growFilesystem('/imps/a/disk.ext4');

  await held.reached;

  const whileHeld = Bun.peek.status(growing);

  held.release();

  await growing;

  expect(whileHeld).toBe('pending');
  expect(tools.grows).toStrictEqual(['/imps/a/disk.ext4']);
});
