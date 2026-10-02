import { statSync, truncateSync } from 'node:fs';
import { ORPCError } from '@orpc/server';
import { runChecked } from '../process/run-command';

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

// Grows a stopped disk's ext4 on the host, leaving its new inode tables as
// holes (docs/architecture/storage.md#disk-sizes). An unclean filesystem is
// left for the guest, after its journal replays.
export async function growFilesystem(disk: string): Promise<boolean> {
  const header = await runChecked(['dumpe2fs', '-h', disk]);

  const state = /^Filesystem state:\s+(?<state>.+)$/m.exec(header)?.groups?.['state']?.trim();
  const features = /^Filesystem features:\s+(?<features>.+)$/m.exec(header)?.groups?.['features'];

  if (state !== 'clean' || features === undefined || features.includes('needs_recovery')) {
    return false;
  }

  await runChecked(['resize2fs', '-f', disk]);

  return true;
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
