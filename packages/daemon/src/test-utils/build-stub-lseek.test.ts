import { expect, onTestFinished, test } from 'bun:test';
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDataBlocks } from '../backup/find-data-blocks';
import { buildStubLseek } from './build-stub-lseek';

test('it answers SEEK_DATA with the next extent’s start from a hole', () => {
  const lseek = buildStubLseek({ size: 8192, extents: [[4096, 6144]] });

  expect(lseek.seek(3, 1000, 3)).toStrictEqual({ offset: 4096 });
});

test('it answers SEEK_DATA with the offset itself inside an extent', () => {
  const lseek = buildStubLseek({ size: 8192, extents: [[4096, 6144]] });

  expect(lseek.seek(3, 5000, 3)).toStrictEqual({ offset: 5000 });
});

test('it answers SEEK_DATA past the last extent with ENXIO', () => {
  const lseek = buildStubLseek({ size: 8192, extents: [[0, 4096]] });

  expect(lseek.seek(3, 4096, 3)).toStrictEqual({ errno: 6 });
});

test('it answers SEEK_HOLE with the extent’s end inside an extent', () => {
  const lseek = buildStubLseek({ size: 8192, extents: [[0, 4096]] });

  expect(lseek.seek(3, 1000, 4)).toStrictEqual({ offset: 4096 });
});

test('it answers SEEK_HOLE with the offset itself inside a hole', () => {
  const lseek = buildStubLseek({ size: 8192, extents: [[0, 4096]] });

  expect(lseek.seek(3, 5000, 4)).toStrictEqual({ offset: 5000 });
});

test('it answers SEEK_DATA at the end of the file with ENXIO', () => {
  const lseek = buildStubLseek({ size: 8192, extents: [[0, 8192]] });

  expect(lseek.seek(3, 8192, 3)).toStrictEqual({ errno: 6 });
});

test('it answers SEEK_HOLE at the end of the file with ENXIO', () => {
  const lseek = buildStubLseek({ size: 8192, extents: [[0, 8192]] });

  expect(lseek.seek(3, 8192, 4)).toStrictEqual({ errno: 6 });
});

test('it answers SEEK_DATA with a stale ENXIO from the given offset, over data', () => {
  const lseek = buildStubLseek({ size: 8192, extents: [[4096, 8192]], staleEnxioFrom: 4096 });

  expect(lseek.seek(3, 4096, 3)).toStrictEqual({ errno: 6 });
});

test('it fails SEEK_DATA with the given errno', () => {
  const lseek = buildStubLseek({ size: 8192, extents: [[0, 4096]], dataErrno: 5 });

  expect(lseek.seek(3, 0, 3)).toStrictEqual({ errno: 5 });
});

test('it fails SEEK_HOLE with the given errno', () => {
  const lseek = buildStubLseek({ size: 8192, extents: [[0, 4096]], holeErrno: 22 });

  expect(lseek.seek(3, 0, 4)).toStrictEqual({ errno: 22 });
});

test('it counts the extents and the metadata as allocated', () => {
  const lseek = buildStubLseek({
    size: 8192,
    extents: [
      [0, 1024],
      [4096, 6144],
    ],
    metadataBytes: 512,
  });

  expect(lseek.readAllocated(3)).toBe(3584);
});

test('it finds the same blocks as the kernel’s lseek on a real sparse file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stub-lseek-test-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fd = openSync(join(dir, 'sparse'), 'w+');

  onTestFinished(() => {
    closeSync(fd);
  });

  writeSync(fd, Buffer.alloc(3 * 1024 ** 2, 1), 0, 3 * 1024 ** 2, 0);
  writeSync(fd, Buffer.alloc(2 * 1024 ** 2, 2), 0, 2 * 1024 ** 2, 40 * 1024 ** 2);
  ftruncateSync(fd, 48 * 1024 ** 2);

  const lseek = buildStubLseek({
    size: 48 * 1024 ** 2,
    extents: [
      [0, 3 * 1024 ** 2],
      [40 * 1024 ** 2, 42 * 1024 ** 2],
    ],
  });

  const real = findDataBlocks(fd, 48 * 1024 ** 2, 1024 ** 2);
  const stubbed = findDataBlocks(3, 48 * 1024 ** 2, 1024 ** 2, lseek.seek, lseek.readAllocated);

  expect([...stubbed]).toIncludeSameMembers([...real]);
});
