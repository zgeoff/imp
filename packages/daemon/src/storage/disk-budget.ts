import { ORPCError } from '@orpc/server';
import { createKeyedMutex } from '../imps/keyed-mutex';
import type { StorageBackend } from './storage-backend';

const GIB = 1024 ** 3;

// the default reserve: max(5 GiB, 5 % of the filesystem or pool)
const RESERVE_MIN_BYTES = 5 * GIB;
const RESERVE_FRACTION = 0.05;

interface DiskStatus {
  readonly usedBytes: number;
  readonly availableBytes: number;

  // promised to writes under way, such as a sleep's memory file
  readonly pendingBytes: number;
  readonly reserveBytes: number;

  // free space, less what is pending, is below twice the reserve
  readonly isLow: boolean;
}

// One ledger of free space: each write's estimate is held until it ends, and a
// write that would leave less than the reserve is refused. A thin clone's
// estimate is 0, so it is refused only once the reserve is reached.
export interface DiskBudget {
  readonly withRoom: <T>(bytes: number, task: () => Promise<T>) => Promise<T>;

  // withRoom for a write whose size shows only as it goes, such as a
  // build's export: grow(total) holds up to total, or refuses as withRoom
  readonly withGrowingRoom: <T>(
    task: (grow: (totalBytes: number) => Promise<void>) => Promise<T>,
  ) => Promise<T>;

  // withRoom for a write the estimate cannot see, such as a thin clone
  readonly requireRoom: (bytes: number) => Promise<void>;
  readonly readStatus: () => Promise<DiskStatus>;
}

interface DiskBudgetDeps {
  readonly storage: Pick<StorageBackend, 'readUsage'>;

  // null: the default reserve
  readonly reserveBytes: number | null;

  // how long a write's hold outlives it: ZFS reports a write's blocks in
  // `available` only once its transaction group commits, about 5 s later
  readonly releaseDelayMs?: number;
  readonly log: (message: string) => void;
}

function buildDiskFullError(availableBytes: number, reserveBytes: number, requestedBytes: number) {
  const formatGib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;

  return new ORPCError('DISK_FULL', {
    status: 507,
    message: `not enough free disk: ${formatGib(availableBytes)} free, ${formatGib(requestedBytes)} wanted, and ${formatGib(reserveBytes)} is held in reserve (IMP_DISK_RESERVE_GIB)`,
    data: { availableBytes, reserveBytes, requestedBytes },
  });
}

export function createDiskBudget(deps: DiskBudgetDeps): DiskBudget {
  const mutex = createKeyedMutex();
  const ledger = { pendingBytes: 0, wasLow: false };

  const readStatus = async (): Promise<DiskStatus> => {
    const usage = await deps.storage.readUsage();

    const sizeBytes = usage.usedBytes + usage.availableBytes;

    const reserveBytes =
      deps.reserveBytes ?? Math.max(RESERVE_MIN_BYTES, Math.round(sizeBytes * RESERVE_FRACTION));

    const free = usage.availableBytes - ledger.pendingBytes;
    const isLow = free < 2 * reserveBytes;

    // once per episode: it ends a GiB clear of the line, so free space that
    // hovers at it logs nothing more
    const isEpisodeOver = free >= 2 * reserveBytes + GIB;

    if (isLow ? !ledger.wasLow : ledger.wasLow && isEpisodeOver) {
      ledger.wasLow = isLow;

      const message = isLow
        ? `impd: warning: low on disk: ${String(Math.round(free / GIB))} GiB free, the reserve is ${String(Math.round(reserveBytes / GIB))} GiB`
        : 'impd: disk space is back above twice the reserve';

      deps.log(message);
    }

    return { ...usage, pendingBytes: ledger.pendingBytes, reserveBytes, isLow };
  };

  // the check and the hold run under one lock, so two writes never both
  // pass on the same reading
  const holdRoom = (bytes: number) =>
    mutex.runExclusive('ledger', async () => {
      const status = await readStatus();

      const free = status.availableBytes - status.pendingBytes;

      if (free - bytes < status.reserveBytes) {
        throw buildDiskFullError(Math.max(0, free), status.reserveBytes, bytes);
      }

      ledger.pendingBytes += bytes;
    });

  const removeHold = (bytes: number) => {
    const delayMs = deps.releaseDelayMs ?? 0;

    if (delayMs === 0 || bytes === 0) {
      ledger.pendingBytes -= bytes;

      return;
    }

    const timer = setTimeout(() => {
      ledger.pendingBytes -= bytes;
    }, delayMs);

    timer.unref();
  };

  const withRoom = async <T>(bytes: number, task: () => Promise<T>): Promise<T> => {
    await holdRoom(bytes);

    try {
      return await task();
    } finally {
      removeHold(bytes);
    }
  };

  const withGrowingRoom = async <T>(
    task: (grow: (totalBytes: number) => Promise<void>) => Promise<T>,
  ): Promise<T> => {
    const held = { bytes: 0 };

    const grow = async (totalBytes: number) => {
      const more = totalBytes - held.bytes;

      if (more > 0) {
        await holdRoom(more);

        held.bytes += more;
      }
    };

    try {
      return await task(grow);
    } finally {
      removeHold(held.bytes);
    }
  };

  return {
    withRoom,
    withGrowingRoom,
    requireRoom: (bytes) => withRoom(bytes, () => Promise.resolve()),
    readStatus,
  };
}
