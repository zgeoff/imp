import { expect, test } from 'bun:test';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDataBlocks } from './find-data-blocks';

const MIB = 1024 * 1024;

test('it finds the blocks of a sparse file that hold data, and skips the holes', () => {
  const dir = mkdtempSync(`${tmpdir()}/impd-seek-test-`);
  const file = join(dir, 'sparse');
  const fd = openSync(file, 'w+');

  try {
    writeSync(fd, 'head', 0);
    writeSync(fd, 'middle', 5 * MIB + 10);
    writeSync(fd, 'tail', 64 * MIB - 4);

    expect([...findDataBlocks(fd, 64 * MIB, MIB)].toSorted((a, b) => a - b)).toEqual([0, 5, 63]);
    expect(findDataBlocks(fd, 0, MIB).size).toBe(0);
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
});
