import { statSync, truncateSync } from 'node:fs';
import { ORPCError } from '@orpc/server';

export const MIB = 1024 * 1024;

// A disk only grows: the guest's ext4 cannot shrink online, and a smaller
// file would cut it off. Returns the file's size after.
export function growDiskFile(disk: string, diskBytes: number): number {
  const size = statSync(disk).size;

  if (diskBytes > size) {
    truncateSync(disk, diskBytes);

    return diskBytes;
  }

  return size;
}

export function readFileBytes(path: string): number {
  return statSync(path).size;
}

export function buildDiskTooSmallError(diskBytes: number, floorBytes: number, why: string) {
  return new ORPCError('BAD_REQUEST', {
    message: `a disk of ${formatMib(diskBytes)} is smaller than ${why} (${formatMib(floorBytes)})`,
  });
}

function formatMib(bytes: number): string {
  return `${String(Math.ceil(bytes / MIB))} MiB`;
}
