import { expect, onTestFinished, test } from 'bun:test';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('it reads every block when SEEK_HOLE fails with an error other than ENXIO', () => {
  // SEEK_DATA (3) answers at the offset asked; SEEK_HOLE fails with EINVAL
  const blocks = findDataBlocks(3, 4 * 1024 ** 2, 1024 ** 2, (_fd, offset, whence) =>
    whence === 3 ? { offset } : { errno: 22 },
  );

  expect([...blocks]).toIncludeSameMembers([0, 1, 2, 3]);
});

test('it reads every block when SEEK_DATA fails with an error other than ENXIO', () => {
  // every seek fails with EIO
  const blocks = findDataBlocks(3, 2 * 1024 ** 2, 1024 ** 2, () => ({ errno: 5 }));

  expect([...blocks]).toIncludeSameMembers([0, 1]);
});

test('it finds no blocks when SEEK_DATA answers ENXIO and nothing is allocated', () => {
  // SEEK_DATA answers ENXIO from the start, and fstat counts no blocks
  const blocks = findDataBlocks(
    3,
    2 * 1024 ** 2,
    1024 ** 2,
    (_fd, offset, whence) => (whence === 3 ? { errno: 6 } : { offset }),
    () => 0,
  );

  expect(blocks).toBeEmpty();
});

test('it reads every block from a hole start when fstat counts more than a stale ENXIO found', () => {
  // data in block 0, a hole at 1 MiB, data at 2 MiB; SEEK_DATA at the hole
  // start answers ENXIO, SEEK_HOLE agrees, and fstat counts 3 MiB allocated
  const blocks = findDataBlocks(
    3,
    4 * 1024 ** 2,
    1024 ** 2,
    (_fd, offset, whence) => {
      if (whence === 3) {
        return offset === 0 ? { offset: 0 } : { errno: 6 };
      }

      return { offset: offset === 0 ? 1024 ** 2 : offset };
    },
    () => 3 * 1024 ** 2,
  );

  expect([...blocks]).toIncludeSameMembers([0, 1, 2, 3]);
});

test('it keeps the scan when fstat counts no more than metadata past what it found', () => {
  // as above, but fstat counts one 4 KiB block past the 1 MiB found
  const blocks = findDataBlocks(
    3,
    4 * 1024 ** 2,
    1024 ** 2,
    (_fd, offset, whence) => {
      if (whence === 3) {
        return offset === 0 ? { offset: 0 } : { errno: 6 };
      }

      return { offset: offset === 0 ? 1024 ** 2 : offset };
    },
    () => 1024 ** 2 + 4096,
  );

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

  // a stale ENXIO after the first extent, which ends at 3 MiB
  const blocks = findDataBlocks(ctx.fd, 42 * 1024 ** 2, 1024 ** 2, (_fd, offset, whence) =>
    whence === 3 && offset > 0 ? { errno: 6 } : { offset: whence === 3 ? 0 : 3 * 1024 ** 2 },
  );

  expect(blocks.size).toBe(42);
});
