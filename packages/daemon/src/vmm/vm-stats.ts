import { readFileSync } from 'node:fs';
import { isFirecrackerAlive } from './firecracker-process';

const KIB_PER_MIB = 1024;

export interface VmRam {
  readonly rssMib: number;

  // what the governor counts (docs/sleep-findings.md 5): anonymous and shmem
  // pages. Pages a woken guest only read are clean pages of the mem file,
  // which the host can drop and read again.
  readonly ownedMib: number;
}

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

// null when the pid is not this Firecracker (gone, or recycled)
export function readVmRam(pid: number, apiSocket: string): VmRam | null {
  if (!isFirecrackerAlive(pid, apiSocket)) {
    return null;
  }

  try {
    const fields = parseSmapsRollup(readFileSync(`/proc/${String(pid)}/smaps_rollup`, 'utf8'));
    const owned = (fields.get('Pss_Anon') ?? 0) + (fields.get('Pss_Shmem') ?? 0);

    return {
      rssMib: Math.round((fields.get('Rss') ?? 0) / KIB_PER_MIB),
      ownedMib: Math.round(owned / KIB_PER_MIB),
    };
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
