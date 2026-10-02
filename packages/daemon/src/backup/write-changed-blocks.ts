import { open } from 'node:fs/promises';
import { findDataBlocks } from './find-data-blocks';

// read in large pieces; compared and written in record-sized ones
const READ_BYTES = 1024 * 1024;

// the ZFS disk recordsize (BLOCK_RECORDSIZE) and a multiple of XFS's 4 KiB
const WRITE_BYTES = 16 * 1024;

// Makes `target` hold the bytes of `source`, writing only the blocks that
// differ. A zero block over a hole stays a hole, and on ZFS or XFS a block
// left alone stays shared with the snapshot or clone taken before.
export async function writeChangedBlocks(source: string, target: string): Promise<number> {
  const input = await open(source, 'r');
  const output = await open(target, 'r+');

  const wanted = Buffer.alloc(READ_BYTES);
  const present = Buffer.alloc(READ_BYTES);
  let written = 0;

  try {
    const stats = await input.stat();

    const size = stats.size;

    const targetStats = await output.stat();

    // a block that is a hole in both files is zeros in both
    const blocks = new Set([
      ...findDataBlocks(input.fd, size, READ_BYTES),
      ...findDataBlocks(output.fd, Math.min(targetStats.size, size), READ_BYTES),
    ]);

    for (const block of [...blocks].toSorted((a, b) => a - b)) {
      const offset = block * READ_BYTES;
      const length = Math.min(READ_BYTES, size - offset);

      // past the end of target reads as zeros, like a hole
      present.fill(0);

      await input.read(wanted, 0, length, offset);
      await output.read(present, 0, length, offset);

      if (wanted.compare(present, 0, length, 0, length) === 0) {
        continue;
      }

      for (let start = 0; start < length; start += WRITE_BYTES) {
        const end = Math.min(start + WRITE_BYTES, length);

        if (wanted.compare(present, start, end, start, end) !== 0) {
          await output.write(wanted, start, end - start, offset + start);

          written += end - start;
        }
      }
    }

    await output.truncate(size);
    await output.sync();

    return written;
  } finally {
    await input.close();
    await output.close();
  }
}
