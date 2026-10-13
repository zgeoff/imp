import { fstatSync } from 'node:fs';
import { getLibc, readErrno } from '../process/libc';

// lseek(2) whence values and the one errno that is an answer, on Linux
const SEEK_DATA = 3;
const SEEK_HOLE = 4;
const ENXIO = 6;

// allocated bytes past the found data that are still file-system metadata,
// not data the scan missed; a file restic restored measured 0 on XFS and ext4
const SLACK_MIN_BYTES = 1024 * 1024;
const SLACK_FRACTION = 0.001;

// an lseek result: the offset, or the errno of a -1
type SeekResult = { readonly offset: number } | { readonly errno: number };

export type SeekFile = (fd: number, offset: number, whence: number) => SeekResult;

export type ReadAllocated = (fd: number) => number;

function runLseek(fd: number, offset: number, whence: number): SeekResult {
  const libc = getLibc();

  if (libc === null) {
    return { errno: -1 };
  }

  const result = Number(libc.lseek(fd, offset, whence));

  if (result >= 0) {
    return { offset: result };
  }

  return { errno: readErrno() };
}

function buildBlocksFrom(
  found: ReadonlySet<number>,
  offset: number,
  size: number,
  blockBytes: number,
): Set<number> {
  const blocks = new Set(found);

  for (let block = Math.floor(offset / blockBytes); block * blockBytes < size; block += 1) {
    blocks.add(block);
  }

  return blocks;
}

function readFileAllocated(fd: number): number {
  return fstatSync(fd).blocks * 512;
}

// The scan ended early when the file holds more allocated bytes than the
// data it found, past the slack. This needs no errno, which may be stale.
function isScanShort(foundBytes: number, allocated: number): boolean {
  return allocated - foundBytes > Math.max(SLACK_MIN_BYTES, allocated * SLACK_FRACTION);
}

// The indexes of the `blockBytes` blocks that hold data: SEEK_DATA skips a
// sparse disk's holes. Any answer it cannot confirm means every block from
// there, never a block left out.
export function findDataBlocks(
  fd: number,
  size: number,
  blockBytes: number,
  seek: SeekFile = runLseek,
  readAllocated: ReadAllocated = readFileAllocated,
): Set<number> {
  const blocks = new Set<number>();

  let foundBytes = 0;
  let offset = 0;

  while (offset < size) {
    const data = seek(fd, offset, SEEK_DATA);

    if ('errno' in data && data.errno !== ENXIO) {
      return buildBlocksFrom(blocks, offset, size, blockBytes);
    }

    if ('errno' in data || data.offset >= size) {
      break;
    }

    const hole = seek(fd, data.offset, SEEK_HOLE);

    if ('errno' in hole) {
      return buildBlocksFrom(blocks, data.offset, size, blockBytes);
    }

    const end = Math.min(hole.offset, size);

    for (let block = Math.floor(data.offset / blockBytes); block * blockBytes < end; block += 1) {
      blocks.add(block);
    }

    foundBytes += end - data.offset;
    offset = end;
  }

  if (offset < size && isScanShort(foundBytes, readAllocated(fd))) {
    return buildBlocksFrom(blocks, offset, size, blockBytes);
  }

  return blocks;
}
