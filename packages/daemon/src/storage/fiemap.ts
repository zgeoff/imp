import { ptr } from 'bun:ffi';
import { closeSync, openSync } from 'node:fs';
import { getLibc, readErrno } from '../process/libc';

// _IOWR('f', 11, struct fiemap): the 32-byte header; extents follow it
const FS_IOC_FIEMAP = 0xc0_20_66_0b;
const HEADER_BYTES = 32;
const EXTENT_BYTES = 56;

// extents per call: the call holds the file's inode lock, which a running
// guest's writes wait on
const BATCH_EXTENTS = 1024;

export const EXTENT_FLAGS = {
  last: 0x1,

  // DELALLOC: the data has no block yet, so no physical address either
  delalloc: 0x4,
  shared: 0x20_00,
} as const;

export interface Extent {
  readonly logical: number;
  readonly physical: number;
  readonly length: number;
  readonly flags: number;
}

interface ExtentRead {
  readonly extents: Extent[];

  // false when the deadline cut the read short
  readonly isComplete: boolean;
}

// one FIEMAP call from `start`; never FIEMAP_FLAG_SYNC, which would flush the
// guest's dirty pages first
function readBatch(fd: number, start: number, buffer: Uint8Array): Extent[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  buffer.fill(0);
  view.setBigUint64(0, BigInt(start), true);
  view.setBigUint64(8, 0xff_ff_ff_ff_ff_ff_ff_ffn, true);
  view.setUint32(24, BATCH_EXTENTS, true);

  const result = getLibc()?.ioctl(fd, FS_IOC_FIEMAP, ptr(buffer));

  if (result !== 0) {
    throw new Error(`FIEMAP failed: errno ${String(readErrno())}`);
  }

  const mapped = view.getUint32(20, true);

  return Array.from({ length: mapped }, (_unused, index) => {
    const at = HEADER_BYTES + index * EXTENT_BYTES;

    return {
      logical: Number(view.getBigUint64(at, true)),
      physical: Number(view.getBigUint64(at + 8, true)),
      length: Number(view.getBigUint64(at + 16, true)),
      flags: view.getUint32(at + 40, true),
    };
  });
}

// The file's extents, a batch at a time with the event loop free between
// batches, until the last one or `deadline` (a Date.now time).
export async function readExtents(path: string, deadline: number): Promise<ExtentRead> {
  const fd = openSync(path, 'r');

  const buffer = new Uint8Array(HEADER_BYTES + BATCH_EXTENTS * EXTENT_BYTES);

  const extents: Extent[] = [];

  try {
    for (let start = 0; ;) {
      if (Date.now() > deadline) {
        return { extents, isComplete: false };
      }

      const batch = readBatch(fd, start, buffer);
      const last = batch.at(-1);

      extents.push(...batch);

      if (last === undefined || (last.flags & EXTENT_FLAGS.last) !== 0) {
        return { extents, isComplete: true };
      }

      start = last.logical + last.length;

      await Bun.sleep(0);
    }
  } finally {
    closeSync(fd);
  }
}
