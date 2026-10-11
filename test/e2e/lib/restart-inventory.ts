import { listCheckpoints, listImps } from './imp-cli';
import type { ImpRow } from './imp-cli';

export interface InventoryEntry {
  readonly name: string;
  readonly id: string;
  readonly image: string;
  readonly slot: number;
  readonly port: number;
  readonly vcpus: number;
  readonly memoryMib: number;
  readonly checkpoints: readonly string[];
}

// An imp's row without its volatile fields (state, RAM, activity), with its
// checkpoint ids sorted: what a restart or a reboot must keep.
export function buildInventoryEntry(
  row: Readonly<ImpRow>,
  checkpointIds: readonly string[],
): InventoryEntry {
  return {
    name: row.name,
    id: row.id,
    image: row.image,
    slot: row.slot,
    port: row.port,
    vcpus: row.vcpus,
    memoryMib: row.memoryMib,
    checkpoints: checkpointIds.toSorted(),
  };
}

// The rows that are neither sleeping nor stopped, as `<name> <state>`.
export function findAwakeRows(rows: readonly Readonly<ImpRow>[]): readonly string[] {
  return rows
    .filter((row) => row.state !== 'sleeping' && row.state !== 'stopped')
    .map((row) => `${row.name} ${row.state}`);
}

// every imp on the instance by name, as buildInventoryEntry keeps it
export async function readInventory(): Promise<readonly InventoryEntry[]> {
  const rows = await listImps();

  const sorted = rows.toSorted((a, b) => a.name.localeCompare(b.name));

  const checkpoints = await Promise.all(sorted.map((row) => listCheckpoints(row.name)));

  return sorted.map((row, index) =>
    buildInventoryEntry(
      row,
      (checkpoints[index] ?? []).map((checkpoint) => checkpoint.id),
    ),
  );
}

export async function listAwakeImps(): Promise<readonly string[]> {
  const rows = await listImps();

  return findAwakeRows(rows);
}
