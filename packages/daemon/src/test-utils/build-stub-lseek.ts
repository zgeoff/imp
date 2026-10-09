import type { ReadAllocated, SeekFile } from '../backup/find-data-blocks';

// lseek(2) on Linux: whence values and the errno that means no more data
const SEEK_DATA = 3;
const SEEK_HOLE = 4;
const ENXIO = 6;

interface StubLseekOptions {
  // the file's length, and its data as sorted [start, end) byte ranges
  readonly size: number;
  readonly extents: readonly (readonly [number, number])[];

  // a stale ENXIO: SEEK_DATA answers it at or past this offset, data or not
  readonly staleEnxioFrom?: number;

  // SEEK_DATA or SEEK_HOLE fails with this errno at every offset
  readonly dataErrno?: number;
  readonly holeErrno?: number;

  // allocated bytes past the extents, as file-system metadata
  readonly metadataBytes?: number;
}

// lseek's SEEK_DATA and SEEK_HOLE over a sparse file's extents, and fstat's
// allocated bytes, as findDataBlocks reads them; with the faults a test sets
export function buildStubLseek(options: Readonly<StubLseekOptions>) {
  const runSeek: SeekFile = (_fd, offset, whence) => {
    if (whence === SEEK_DATA) {
      return findData(options, offset);
    }

    if (whence === SEEK_HOLE) {
      return findHole(options, offset);
    }

    return { errno: 22 };
  };

  const allocated = options.extents.reduce((total, [start, end]) => total + end - start, 0);
  const readAllocated: ReadAllocated = () => allocated + (options.metadataBytes ?? 0);

  return { seek: runSeek, readAllocated };
}

// the start of the data at or after offset; ENXIO past the last data or EOF
function findData(options: Readonly<StubLseekOptions>, offset: number) {
  if (options.dataErrno !== undefined) {
    return { errno: options.dataErrno };
  }

  if (offset >= options.size || offset >= (options.staleEnxioFrom ?? Infinity)) {
    return { errno: ENXIO };
  }

  const extent = options.extents.find(([, end]) => end > offset);

  return extent === undefined ? { errno: ENXIO } : { offset: Math.max(extent[0], offset) };
}

// the start of the hole at or after offset; EOF counts as a hole
function findHole(options: Readonly<StubLseekOptions>, offset: number) {
  if (options.holeErrno !== undefined) {
    return { errno: options.holeErrno };
  }

  if (offset >= options.size) {
    return { errno: ENXIO };
  }

  const extent = options.extents.find(([start, end]) => start <= offset && offset < end);

  return { offset: extent === undefined ? offset : Math.min(extent[1], options.size) };
}
