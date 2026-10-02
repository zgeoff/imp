import type { OrphanStorage, SweepResult } from './storage-backend';

const MIB = 1024 ** 2;

// how much of the orphans a sweep logs: each and their count, the count
// alone, or nothing (`imp gc` returns them instead)
export type OrphanLogging = 'each' | 'count' | 'none';

// What a sweep did, for the log: each thing it removed, then the orphans it
// kept, as `orphans` says.
export function printSweep(
  log: (message: Readonly<string>) => void,
  prefix: string,
  result: Readonly<SweepResult>,
  orphans: OrphanLogging,
): void {
  for (const dropped of result.dropped) {
    log(`${prefix}: removed ${dropped.kind} ${dropped.id}`);
  }

  if (orphans === 'none' || result.kept.length === 0) {
    return;
  }

  if (orphans === 'each') {
    for (const orphan of result.kept) {
      log(`${prefix}: kept ${formatOrphan(orphan)}`);
    }
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
