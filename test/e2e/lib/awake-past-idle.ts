import { config } from './config';
import type { ImpRow } from './imp-cli';
import { requireImp } from './imp-cli';
import { waitFor } from './wait-for';

export type AwakeRow = Readonly<Pick<ImpRow, 'state' | 'lastActiveAt' | 'resources' | 'sleptAt'>>;

// Whether impd's idle loop found the running imp active `idleTimeoutS` after
// `sinceMs` (it moves lastActiveAt only while something keeps the imp awake),
// with no sleep or wake since `before`.
export function checkAwakePastIdle(
  row: AwakeRow,
  before: AwakeRow,
  sinceMs: number,
  idleTimeoutS: number,
): boolean {
  return (
    row.state === 'running' &&
    Date.parse(row.lastActiveAt) >= sinceMs + idleTimeoutS * 1000 &&
    row.resources?.wakeCount === before.resources?.wakeCount &&
    row.sleptAt === before.sleptAt
  );
}

// Waits, without touching `name` (a listing records no activity), until
// checkAwakePastIdle holds against its first read as running (it may still
// be waking); fails a few idle-loop ticks past the timeout.
export async function waitAwakePastIdle(name: string, sinceMs: number): Promise<void> {
  const before = await waitFor(`${name} to run`, async () => {
    const row = await requireImp(name);

    if (row.state !== 'running') {
      throw new Error(`${name} is ${row.state}`);
    }

    return row;
  });

  await waitFor(
    `${name} to stay awake ${String(config.idleTimeoutS)} s past the idle timeout`,
    async () => {
      const row = await requireImp(name);

      if (!checkAwakePastIdle(row, before, sinceMs, config.idleTimeoutS)) {
        throw new Error(
          `${name} is ${row.state}, last active at ${row.lastActiveAt}, woken ${String(row.resources?.wakeCount)} times, last slept at ${String(row.sleptAt)}`,
        );
      }
    },
    { timeoutMs: (config.idleTimeoutS + 20) * 1000 },
  );
}
