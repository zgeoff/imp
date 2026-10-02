import { FFIType, dlopen, read } from 'bun:ffi';

// lseek(2) whence values and the one errno that is an answer, on Linux
const SEEK_DATA = 3;
const SEEK_HOLE = 4;
const ENXIO = 6;
const libc = loadLibc();

// an lseek result: the offset, or the errno of a -1
type SeekResult = { readonly offset: number } | { readonly errno: number };

export type SeekFile = (fd: number, offset: number, whence: number) => SeekResult;

function loadLibc() {
  try {
    return dlopen('libc.so.6', {
      lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },

      // libc's name for the thread's errno
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

// ENXIO from SEEK_DATA is trusted only when the offset is in a hole by an
// answer of its own
function isHoleAt(fd: number, offset: number, seek: SeekFile): boolean {
  const hole = seek(fd, offset, SEEK_HOLE);

  return !('errno' in hole) && hole.offset === offset;
}

// The indexes of the `blockBytes` blocks that hold data: SEEK_DATA skips a
// sparse disk's holes. Any answer it cannot confirm means every block from
// there, never a block left out.
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
      if (data.errno === ENXIO && isHoleAt(fd, offset, seek)) {
        break;
      }

      // errno comes from a second FFI call and may be stale: data left out
      // would be lost, so every block from here on is read instead
      return buildBlocksFrom(blocks, offset, size, blockBytes);
    }

    if (data.offset >= size) {
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

    offset = end;
  }

  return blocks;
}
