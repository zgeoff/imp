import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readExtents } from '../storage/fiemap';
import { buildStubFiemap } from './build-stub-fiemap';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-fiemap-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it answers the extents set for a file, complete', async () => {
  const ctx = await setupTest();

  const fiemap = buildStubFiemap();

  writeFileSync(join(ctx.dir, 'disk.ext4'), 'disk');

  fiemap.setExtents(join(ctx.dir, 'disk.ext4'), [
    { logical: 0, physical: 8192, length: 4096, flags: 1 },
  ]);

  const read = await fiemap.readFileExtents(join(ctx.dir, 'disk.ext4'), Number.POSITIVE_INFINITY);

  expect(read).toStrictEqual({
    extents: [{ logical: 0, physical: 8192, length: 4096, flags: 1 }],
    isComplete: true,
  });
});

test('it answers no extents for a file with none set', async () => {
  const ctx = await setupTest();

  const fiemap = buildStubFiemap();

  writeFileSync(join(ctx.dir, 'disk.ext4'), '');

  const read = await fiemap.readFileExtents(join(ctx.dir, 'disk.ext4'), Number.POSITIVE_INFINITY);

  expect(read).toStrictEqual({ extents: [], isComplete: true });
});

test('it answers a cut read as incomplete until the cut is lifted', async () => {
  const ctx = await setupTest();

  const fiemap = buildStubFiemap();

  writeFileSync(join(ctx.dir, 'disk.ext4'), 'disk');

  fiemap.setCut(join(ctx.dir, 'disk.ext4'), true);

  const cut = await fiemap.readFileExtents(join(ctx.dir, 'disk.ext4'), Number.POSITIVE_INFINITY);

  fiemap.setCut(join(ctx.dir, 'disk.ext4'), false);

  const whole = await fiemap.readFileExtents(join(ctx.dir, 'disk.ext4'), Number.POSITIVE_INFINITY);

  expect(cut.isComplete).toBeFalse();
  expect(whole.isComplete).toBeTrue();
});

test('it rejects a read of a failed file with its error', async () => {
  const ctx = await setupTest();

  const fiemap = buildStubFiemap();

  writeFileSync(join(ctx.dir, 'disk.ext4'), 'disk');

  fiemap.failAt(join(ctx.dir, 'disk.ext4'), new Error('EIO: i/o error'));

  expect(
    fiemap.readFileExtents(join(ctx.dir, 'disk.ext4'), Number.POSITIVE_INFINITY),
  ).rejects.toThrowWithMessage(Error, 'EIO: i/o error');
});

test('it rejects a read of a missing file, as the real FIEMAP read does', async () => {
  const ctx = await setupTest();

  const fiemap = buildStubFiemap();

  expect(
    fiemap.readFileExtents(join(ctx.dir, 'gone.ext4'), Number.POSITIVE_INFINITY),
  ).rejects.toThrow(/^ENOENT: no such file or directory/);

  expect(readExtents(join(ctx.dir, 'gone.ext4'), Number.POSITIVE_INFINITY)).rejects.toThrow(
    /^ENOENT: no such file or directory/,
  );
});

test('it removes a file marked to go just before its read, and rejects the read as missing', async () => {
  const ctx = await setupTest();

  const fiemap = buildStubFiemap();

  writeFileSync(join(ctx.dir, 'disk.ext4'), 'disk');

  fiemap.removeBefore(join(ctx.dir, 'disk.ext4'));

  expect(
    fiemap.readFileExtents(join(ctx.dir, 'disk.ext4'), Number.POSITIVE_INFINITY),
  ).rejects.toThrowWithMessage(
    Error,
    `ENOENT: no such file or directory, open '${join(ctx.dir, 'disk.ext4')}'`,
  );

  expect(existsSync(join(ctx.dir, 'disk.ext4'))).toBeFalse();
});

test('it records each path it reads, in order', async () => {
  const ctx = await setupTest();

  const fiemap = buildStubFiemap();

  writeFileSync(join(ctx.dir, 'a.ext4'), 'a');
  writeFileSync(join(ctx.dir, 'b.ext4'), 'b');

  await fiemap.readFileExtents(join(ctx.dir, 'b.ext4'), Number.POSITIVE_INFINITY);
  await fiemap.readFileExtents(join(ctx.dir, 'a.ext4'), Number.POSITIVE_INFINITY);

  expect(fiemap.reads).toStrictEqual([join(ctx.dir, 'b.ext4'), join(ctx.dir, 'a.ext4')]);
});
