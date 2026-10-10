import { config } from './config';
import type { ImpRow } from './imp-cli';
import { requireImp } from './imp-cli';
import { waitFor } from './wait-for';

// Whether impd's idle loop found the running imp active `idleTimeoutS` after
// `sinceMs`. The loop moves lastActiveAt only while something keeps the imp
// awake, so an imp that nothing kept awake sleeps before it gets that far.
export function checkAwakePastIdle(
  row: Readonly<Pick<ImpRow, 'state' | 'lastActiveAt'>>,
  sinceMs: number,
  idleTimeoutS: number,
): boolean {
  return row.state === 'running' && Date.parse(row.lastActiveAt) >= sinceMs + idleTimeoutS * 1000;
}

// Waits until something has kept `name` awake for the run's idle timeout
// past `sinceMs`, without touching it: listing an imp records no activity.
// It fails once a few idle-loop ticks pass the timeout without that.
export async function waitAwakePastIdle(name: string, sinceMs: number): Promise<void> {
  await waitFor(
    `${name} to stay awake ${String(config.idleTimeoutS)} s past the idle timeout`,
    async () => {
      const row = await requireImp(name);

      if (!checkAwakePastIdle(row, sinceMs, config.idleTimeoutS)) {
        throw new Error(`${name} is ${row.state}, last active at ${row.lastActiveAt}`);
      }
    },
    { timeoutMs: (config.idleTimeoutS + 20) * 1000 },
  );
}
