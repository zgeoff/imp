import { expect, test } from 'bun:test';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SeekFile } from './find-data-blocks';
import { findDataBlocks } from './find-data-blocks';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function sortBlocks(blocks: ReadonlySet<number>): number[] {
  return [...blocks].toSorted((a, b) => a - b);
}

function setupSparseFile() {
  const dir = mkdtempSync(`${tmpdir()}/impd-seek-test-`);
  const fd = openSync(join(dir, 'sparse'), 'w+');

  return {
    fd,
    [Symbol.dispose]: () => {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('it finds the blocks of a sparse file that hold data, and skips the holes', () => {
  using file = setupSparseFile();

  writeSync(file.fd, 'head', 0);
  writeSync(file.fd, 'middle', 5 * MIB + 10);
  writeSync(file.fd, 'tail', 64 * MIB - 4);

  expect(sortBlocks(findDataBlocks(file.fd, 64 * MIB, MIB))).toEqual([0, 5, 63]);
  expect(findDataBlocks(file.fd, 0, MIB).size).toBe(0);
});

test('it finds data past 4 GiB, where a 32-bit offset would wrap', () => {
  using file = setupSparseFile();

  writeSync(file.fd, 'five', 5 * GIB + 3);
  writeSync(file.fd, 'nine', 9 * GIB);
  writeSync(file.fd, 'end', 32 * GIB - 3);

  expect(sortBlocks(findDataBlocks(file.fd, 32 * GIB, MIB))).toEqual([
    5 * 1024,
    9 * 1024,
    32 * 1024 - 1,
  ]);
});

test('an lseek error other than "no more data" means every block', () => {
  const holeFails = findDataBlocks(3, 4 * MIB, MIB, (_fd, offset, whence) =>
    whence === 3 ? { offset } : { errno: 22 },
  );

  expect(sortBlocks(holeFails)).toEqual([0, 1, 2, 3]);

  const dataFails = findDataBlocks(3, 2 * MIB, MIB, () => ({ errno: 5 }));

  expect(sortBlocks(dataFails)).toEqual([0, 1]);

  // a true ENXIO: nothing is allocated past the data found
  const allHoles = findDataBlocks(
    3,
    2 * MIB,
    MIB,
    (_fd, offset, whence) => (whence === 3 ? { errno: 6 } : { offset }),
    () => 0,
  );

  expect(allHoles.size).toBe(0);
});

test('a stale ENXIO at a hole start, with data after it, reads every block from there', () => {
  // data in block 0, a hole at 1 MiB, data at 2 MiB; SEEK_DATA at the hole
  // start answers ENXIO, and SEEK_HOLE agrees it is a hole
  const runStaleSeek: SeekFile = (_fd, offset, whence) => {
    if (whence === 3) {
      return offset === 0 ? { offset: 0 } : { errno: 6 };
    }

    return offset === 0 ? { offset: MIB } : { offset };
  };

  // fstat counts 3 MiB allocated: 2 MiB more than the scan found
  expect(sortBlocks(findDataBlocks(3, 4 * MIB, MIB, runStaleSeek, () => 3 * MIB))).toEqual([
    0, 1, 2, 3,
  ]);

  // within the slack it is file-system metadata, and the scan stands
  expect(sortBlocks(findDataBlocks(3, 4 * MIB, MIB, runStaleSeek, () => MIB + 4096))).toEqual([0]);
});

test('on a real sparse file, fstat shows the extent a stale ENXIO hid', () => {
  using file = setupSparseFile();

  writeSync(file.fd, Buffer.alloc(3 * MIB, 1), 0, 3 * MIB, 0);
  writeSync(file.fd, Buffer.alloc(2 * MIB, 2), 0, 2 * MIB, 40 * MIB);

  // a stale ENXIO after the first extent: fstat shows the missed one
  const runStaleAfterFirst: SeekFile = (_fd, offset, whence) =>
    whence === 3 && offset > 0 ? { errno: 6 } : { offset: whence === 3 ? 0 : 3 * MIB };

  expect(findDataBlocks(file.fd, 42 * MIB, MIB).size).toBe(5);
  expect(findDataBlocks(file.fd, 42 * MIB, MIB, runStaleAfterFirst).size).toBe(42);
});
