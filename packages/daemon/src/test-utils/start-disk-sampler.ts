import { onTestFinished } from 'bun:test';
import { existsSync, rmSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';

// what one run took of the filesystem, over its use before the run
export interface DiskTrial {
  // 'built', or the error's code, or its text when it has none
  readonly outcome: string;

  // the use once the run marked its write done and synced, which on XFS
  // leaves out blocks held for writes not yet flushed; 0 if never marked
  readonly settledBytes: number;
  readonly peakBytes: number;
  readonly lowestFree: number;
}

function readDisk(mount: string): { free: number; used: number } {
  const stats = statfsSync(mount);

  return { free: stats.bavail * stats.bsize, used: (stats.blocks - stats.bfree) * stats.bsize };
}

function readOutcome(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : String(error);
}

// XFS frees a removed file's blocks in the background: waits until free
// space reads the same twice, 200 ms apart
async function waitForSettled(mount: string): Promise<void> {
  Bun.spawnSync(['sync', '-f', mount]);

  const last = { free: -1 };

  await waitFor(
    () => {
      const free = readDisk(mount).free;
      const isStill = free === last.free;

      last.free = free;

      if (!isStill) {
        throw new Error(`free space on ${mount} is still changing`);
      }
    },
    { intervalMs: 200, timeoutMs: 10_000 },
  );
}

// Samples a filesystem every millisecond while a run writes to it, once its
// free space has settled. A filler of its own, which fill() makes and the
// test's end removes, leaves a chosen room free; `filler` names its path.
export async function startDiskSampler(
  mount: string,
  filler: string = join(mount, `filler-${Bun.randomUUIDv7()}`),
) {
  const seen = { lowestFree: Number.POSITIVE_INFINITY, highestUsed: 0, settledUsed: 0 };

  const updateSeen = () => {
    const disk = readDisk(mount);

    seen.lowestFree = Math.min(seen.lowestFree, disk.free);
    seen.highestUsed = Math.max(seen.highestUsed, disk.used);
  };

  await waitForSettled(mount);

  return {
    // fills the filesystem so that roomBytes is free above reserveBytes
    fill: async (roomBytes: number, reserveBytes: number) => {
      const fillBytes = readDisk(mount).free - reserveBytes - roomBytes;

      if (fillBytes <= 0) {
        throw new Error(`${mount} has less than ${String(roomBytes)} B free above the reserve`);
      }

      if (existsSync(filler)) {
        throw new Error(`${filler} is there already, and not the sampler's`);
      }

      const made = Bun.spawnSync(['fallocate', '-l', String(fillBytes), filler]);

      onTestFinished(() => {
        rmSync(filler, { force: true });
      });

      if (made.exitCode !== 0) {
        throw new Error(`fallocate failed: ${made.stderr.toString()}`);
      }

      await waitForSettled(mount);
    },

    // for the run to call once its writes are all on disk
    markWritten: () => {
      updateSeen();

      Bun.spawnSync(['sync', '-f', mount]);

      seen.settledUsed = readDisk(mount).used;
    },

    measure: async (run: () => Promise<unknown>): Promise<DiskTrial> => {
      const baseUsed = readDisk(mount).used;
      const timer = setInterval(updateSeen, 1);

      onTestFinished(() => {
        clearInterval(timer);
      });

      const outcome = await run().then(() => 'built', readOutcome);

      clearInterval(timer);
      updateSeen();

      return {
        outcome,
        settledBytes: seen.settledUsed === 0 ? 0 : seen.settledUsed - baseUsed,
        peakBytes: seen.highestUsed - baseUsed,
        lowestFree: seen.lowestFree,
      };
    },
  };
}
