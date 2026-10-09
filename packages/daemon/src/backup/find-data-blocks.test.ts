import { expect, onTestFinished, test } from 'bun:test';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubLseek } from '../test-utils/build-stub-lseek';
import { findDataBlocks } from './find-data-blocks';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'impd-seek-test-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fd = openSync(join(dir, 'sparse'), 'w+');

  onTestFinished(() => {
    closeSync(fd);
  });

  return { fd };
}

test('it finds the blocks of a sparse file that hold data, and skips the holes', () => {
  const ctx = setupTest();

  writeSync(ctx.fd, 'head', 0);
  writeSync(ctx.fd, 'middle', 5 * 1024 ** 2 + 10);
  writeSync(ctx.fd, 'tail', 64 * 1024 ** 2 - 4);

  expect([...findDataBlocks(ctx.fd, 64 * 1024 ** 2, 1024 ** 2)]).toIncludeSameMembers([0, 5, 63]);
});

test('it finds no blocks in a scan of no length', () => {
  const ctx = setupTest();

  writeSync(ctx.fd, 'head', 0);

  expect(findDataBlocks(ctx.fd, 0, 1024 ** 2)).toBeEmpty();
});

test('it finds data past 4 GiB, where a 32-bit offset would wrap', () => {
  const ctx = setupTest();

  writeSync(ctx.fd, 'five', 5 * 1024 ** 3 + 3);
  writeSync(ctx.fd, 'nine', 9 * 1024 ** 3);
  writeSync(ctx.fd, 'end', 32 * 1024 ** 3 - 3);

  expect([...findDataBlocks(ctx.fd, 32 * 1024 ** 3, 1024 ** 2)]).toIncludeSameMembers([
    5 * 1024,
    9 * 1024,
    32 * 1024 - 1,
  ]);
});

test('it reads every block from the data found when SEEK_HOLE fails', () => {
  const lseek = buildStubLseek({
    size: 4 * 1024 ** 2,
    extents: [[0, 1024 ** 2]],
    holeErrno: 22,
  });

  const blocks = findDataBlocks(3, 4 * 1024 ** 2, 1024 ** 2, lseek.seek, lseek.readAllocated);

  expect([...blocks]).toIncludeSameMembers([0, 1, 2, 3]);
});

test('it reads every block when SEEK_DATA fails with an error other than ENXIO', () => {
  const lseek = buildStubLseek({ size: 2 * 1024 ** 2, extents: [[0, 1024 ** 2]], dataErrno: 5 });
  const blocks = findDataBlocks(3, 2 * 1024 ** 2, 1024 ** 2, lseek.seek, lseek.readAllocated);

  expect([...blocks]).toIncludeSameMembers([0, 1]);
});

test('it finds no blocks in a file that is one hole', () => {
  const lseek = buildStubLseek({ size: 2 * 1024 ** 2, extents: [] });
  const blocks = findDataBlocks(3, 2 * 1024 ** 2, 1024 ** 2, lseek.seek, lseek.readAllocated);

  expect(blocks).toBeEmpty();
});

test('it reads every block from a hole start when fstat counts more than a stale ENXIO found', () => {
  // SEEK_DATA answers a stale ENXIO at the hole after block 0, over 2 MiB more
  const lseek = buildStubLseek({
    size: 4 * 1024 ** 2,
    extents: [
      [0, 1024 ** 2],
      [2 * 1024 ** 2, 4 * 1024 ** 2],
    ],
    staleEnxioFrom: 1024 ** 2,
  });

  const blocks = findDataBlocks(3, 4 * 1024 ** 2, 1024 ** 2, lseek.seek, lseek.readAllocated);

  expect([...blocks]).toIncludeSameMembers([0, 1, 2, 3]);
});

test('it keeps the scan when fstat counts no more than metadata past what it found', () => {
  // one 4 KiB block of metadata past the 1 MiB of data
  const lseek = buildStubLseek({
    size: 4 * 1024 ** 2,
    extents: [[0, 1024 ** 2]],
    metadataBytes: 4096,
  });

  const blocks = findDataBlocks(3, 4 * 1024 ** 2, 1024 ** 2, lseek.seek, lseek.readAllocated);

  expect([...blocks]).toIncludeSameMembers([0]);
});

test('it finds the extents of a real sparse file', () => {
  const ctx = setupTest();

  writeSync(ctx.fd, Buffer.alloc(3 * 1024 ** 2, 1), 0, 3 * 1024 ** 2, 0);
  writeSync(ctx.fd, Buffer.alloc(2 * 1024 ** 2, 2), 0, 2 * 1024 ** 2, 40 * 1024 ** 2);

  expect([...findDataBlocks(ctx.fd, 42 * 1024 ** 2, 1024 ** 2)]).toIncludeSameMembers([
    0, 1, 2, 40, 41,
  ]);
});

test('it reads every block of a real sparse file when fstat shows an extent a stale ENXIO hid', () => {
  const ctx = setupTest();

  writeSync(ctx.fd, Buffer.alloc(3 * 1024 ** 2, 1), 0, 3 * 1024 ** 2, 0);
  writeSync(ctx.fd, Buffer.alloc(2 * 1024 ** 2, 2), 0, 2 * 1024 ** 2, 40 * 1024 ** 2);

  // the file's own extents, with a stale ENXIO after the first; the real fstat
  const lseek = buildStubLseek({
    size: 42 * 1024 ** 2,
    extents: [
      [0, 3 * 1024 ** 2],
      [40 * 1024 ** 2, 42 * 1024 ** 2],
    ],
    staleEnxioFrom: 3 * 1024 ** 2,
  });

  const blocks = findDataBlocks(ctx.fd, 42 * 1024 ** 2, 1024 ** 2, lseek.seek);

  expect(blocks.size).toBe(42);
});
