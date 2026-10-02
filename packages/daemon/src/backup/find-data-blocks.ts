import { FFIType, dlopen, read } from 'bun:ffi';

// lseek(2) whence values and the one errno that is an answer, on Linux
const SEEK_DATA = 3;
const SEEK_HOLE = 4;
const ENXIO = 6;
const libc = loadLibc();

// an lseek result: the offset, or the errno of a -1
export type SeekResult = { readonly offset: number } | { readonly errno: number };

export type SeekFile = (fd: number, offset: number, whence: number) => SeekResult;

function loadLibc() {
  try {
    return dlopen('libc.so.6', {
      lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },

      // oxlint-disable-next-line no-underscore-dangle -- libc's name
      __errno_location: { args: [], returns: FFIType.ptr },
    });
  } catch {
    return null;
  }
}

function runLseek(fd: number, offset: number, whence: number): SeekResult {
  const symbols = libc?.symbols;

  if (symbols === undefined) {
    return { errno: -1 };
  }

  const result = Number(symbols.lseek(fd, offset, whence));

  if (result >= 0) {
    return { offset: result };
  }

  // oxlint-disable-next-line no-underscore-dangle -- libc's name for the thread's errno
  const errnoAt = symbols.__errno_location();

  return { errno: errnoAt === null ? -1 : read.i32(errnoAt) };
}

function listEveryBlock(size: number, blockBytes: number): Set<number> {
  const blocks = new Set<number>();

  for (let block = 0; block * blockBytes < size; block += 1) {
    blocks.add(block);
  }

  return blocks;
}

// The indexes of the `blockBytes` blocks that hold data: SEEK_DATA skips a
// sparse disk's holes. Any error but "no more data" means every block, never
// a block left out.
export function findDataBlocks(
  fd: number,
  size: number,
  blockBytes: number,
  seek: SeekFile = runLseek,
): Set<number> {
  const blocks = new Set<number>();

  for (let offset = 0; offset < size; ) {
    const data = seek(fd, offset, SEEK_DATA);

    if ('errno' in data) {
      if (data.errno === ENXIO) {
        break;
      }

      return listEveryBlock(size, blockBytes);
    }

    if (data.offset >= size) {
      break;
    }

    const hole = seek(fd, data.offset, SEEK_HOLE);

    if ('errno' in hole) {
      return listEveryBlock(size, blockBytes);
    }

    const end = Math.min(hole.offset, size);

    for (let block = Math.floor(data.offset / blockBytes); block * blockBytes < end; block += 1) {
      blocks.add(block);
    }

    offset = end;
  }

  return blocks;
}
