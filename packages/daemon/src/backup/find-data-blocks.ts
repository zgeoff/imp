import { FFIType, dlopen } from 'bun:ffi';

// lseek(2) whence values on Linux
const SEEK_DATA = 3;
const SEEK_HOLE = 4;
const libc = loadLibc();

function loadLibc() {
  try {
    return dlopen('libc.so.6', {
      lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },
    });
  } catch {
    return null;
  }
}

function findOffset(fd: number, offset: number, whence: number): number {
  return Number(libc?.symbols.lseek(fd, offset, whence) ?? -1);
}

// The indexes of the `blockBytes` blocks of the file that hold data. A sparse
// disk is mostly holes: reading 32 GiB of them costs seconds, where SEEK_DATA
// skips them. Every block when libc is not there to ask.
export function findDataBlocks(fd: number, size: number, blockBytes: number): Set<number> {
  const blocks = new Set<number>();

  if (libc === null) {
    for (let block = 0; block * blockBytes < size; block += 1) {
      blocks.add(block);
    }

    return blocks;
  }

  // -1 from SEEK_DATA is ENXIO: no data past the offset
  for (let offset = 0; offset < size; ) {
    const start = findOffset(fd, offset, SEEK_DATA);

    if (start < 0 || start >= size) {
      break;
    }

    const end = Math.min(findOffset(fd, start, SEEK_HOLE), size);

    for (let block = Math.floor(start / blockBytes); block * blockBytes < end; block += 1) {
      blocks.add(block);
    }

    offset = end;
  }

  return blocks;
}
