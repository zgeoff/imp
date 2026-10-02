import type { OrphanStorage, SweepResult } from './storage-backend';

const MIB = 1024 ** 2;

// What a sweep did, for the log: each thing it removed, then each orphan it
// kept and their count. Start and the hourly pass log orphans; `imp gc`
// returns them instead, so a run by hand never repeats the list.
export function printSweep(
  log: (message: Readonly<string>) => void,
  prefix: string,
  result: Readonly<SweepResult>,
  options: Readonly<{ isOrphansLogged: boolean }>,
): void {
  for (const dropped of result.dropped) {
    log(`${prefix}: removed ${dropped.kind} ${dropped.id}`);
  }

  if (!options.isOrphansLogged || result.kept.length === 0) {
    return;
  }

  for (const orphan of result.kept) {
    log(`${prefix}: kept ${formatOrphan(orphan)}`);
  }

  log(
    `${prefix}: kept ${String(result.kept.length)} orphans the database does not name; ` +
      '`imp gc --orphans --dry-run` lists what `imp gc --orphans` would retire',
  );
}

function formatOrphan(orphan: Readonly<OrphanStorage>): string {
  const size = `${(orphan.bytes / MIB).toFixed(1)} MiB`;
  const created = orphan.createdAt?.toISOString() ?? 'unknown';
  const snapshots = orphan.snapshots.length === 0 ? 'none' : orphan.snapshots.join(', ');

  return `orphan ${orphan.kind} ${orphan.id} (${orphan.location}): ${size}, created ${created}, snapshots: ${snapshots}`;
}
