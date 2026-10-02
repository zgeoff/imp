import { readFileSync } from 'node:fs';
import { isFirecrackerAlive } from './firecracker-process';

const KIB_PER_MIB = 1024;

// `Name:   1234 kB` lines of /proc/<pid>/smaps_rollup → kB by name
export function parseSmapsRollup(text: string): ReadonlyMap<string, number> {
  const fields = new Map<string, number>();

  for (const line of text.split('\n')) {
    const match = /^(?<name>\w+):\s+(?<kb>\d+) kB$/.exec(line);

    if (match?.groups !== undefined) {
      fields.set(match.groups['name'] ?? '', Number(match.groups['kb']));
    }
  }

  return fields;
}

// What the governor counts: anonymous and shmem pages, not the clean mem file pages a woken
// guest only read (docs/architecture/sleep-and-wake.md#5-ram-what-the-governor-measures).
// Null when the pid is not this Firecracker.
export function readOwnedRamMib(pid: number, apiSocket: string): number | null {
  const fields = readVmSmaps(pid, apiSocket);

  if (fields === null) {
    return null;
  }

  return Math.round(((fields.get('Pss_Anon') ?? 0) + (fields.get('Pss_Shmem') ?? 0)) / KIB_PER_MIB);
}

// The VM's anonymous and shmem pages counted in full, as if none were shared. KSM
// splits a merged page's Pss across the VMs that map it, and a write splits the
// page again: a wake reserve of this size holds when the guest writes them all.
export function readUnsharedRamMib(pid: number, apiSocket: string): number | null {
  const fields = readVmSmaps(pid, apiSocket);

  return fields === null ? null : countUnsharedMib(fields);
}

export function countUnsharedMib(fields: ReadonlyMap<string, number>): number {
  return Math.round(
    ((fields.get('Anonymous') ?? 0) + (fields.get('Pss_Shmem') ?? 0)) / KIB_PER_MIB,
  );
}

// All the VM's resident pages (Rss), what `ps` shows; null as above
export function readRssMib(pid: number, apiSocket: string): number | null {
  const fields = readVmSmaps(pid, apiSocket);

  return fields === null ? null : Math.round((fields.get('Rss') ?? 0) / KIB_PER_MIB);
}

// what the governor counts and the whole resident size, from one read
export function readVmMemory(
  pid: number,
  apiSocket: string,
): { readonly ramMib: number | null; readonly rssMib: number | null } {
  const fields = readVmSmaps(pid, apiSocket);

  if (fields === null) {
    return { ramMib: null, rssMib: null };
  }

  const anonKb = (fields.get('Pss_Anon') ?? 0) + (fields.get('Pss_Shmem') ?? 0);

  return {
    ramMib: Math.round(anonKb / KIB_PER_MIB),
    rssMib: Math.round((fields.get('Rss') ?? 0) / KIB_PER_MIB),
  };
}

function readVmSmaps(pid: number, apiSocket: string): ReadonlyMap<string, number> | null {
  if (!isFirecrackerAlive(pid, apiSocket)) {
    return null;
  }

  try {
    return parseSmapsRollup(readFileSync(`/proc/${String(pid)}/smaps_rollup`, 'utf8'));
  } catch {
    return null;
  }
}

// utime + stime in clock ticks (USER_HZ, 100 on Linux), or null when gone
export function readCpuTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');

    // fields after the parenthesised command name, starting at field 3
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return null;
  }
}
