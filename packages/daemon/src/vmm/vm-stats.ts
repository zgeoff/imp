import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { readStatFields } from '../process/proc';
import { isFirecrackerAlive } from './firecracker-process';

const KIB_PER_MIB = 1024;

// Each reader takes `procRoot`, where /proc is mounted: /proc by default.

// `Name:   1234 kB` lines of /proc/<pid>/smaps_rollup → kB by name
export function parseSmapsRollup(text: string): ReadonlyMap<string, number> {
  const fields = new Map<string, number>();

  for (const line of text.split('\n')) {
    const match = /^(?<name>\w+):\s+(?<kb>\d+) kB$/u.exec(line);

    if (match?.groups !== undefined) {
      fields.set(match.groups['name'] ?? '', Number(match.groups['kb']));
    }
  }

  return fields;
}

// What the governor counts: anonymous and shmem pages, not the clean mem file pages a woken
// guest only read (docs/architecture/lifecycle/ram-governor.md#what-it-measures).
// Null when the pid is not this Firecracker.
export function readOwnedRamMib(pid: number, apiSocket: string, procRoot = '/proc'): number | null {
  const fields = readVmSmaps(pid, apiSocket, procRoot);

  return fields === null ? null : countOwnedMib(fields);
}

// readOwnedRamMib off the event loop. The kernel walks every page the VM maps
// to answer, tens of ms for a guest of some GiB, so the governor reads each
// awake VM this way, all at once, rather than holding every request in turn.
export async function readOwnedRamMibAsync(
  pid: number,
  apiSocket: string,
  procRoot = '/proc',
): Promise<number | null> {
  if (!isFirecrackerAlive(pid, apiSocket, procRoot)) {
    return null;
  }

  try {
    const text = await readFile(`${procRoot}/${String(pid)}/smaps_rollup`, 'utf8');

    return countOwnedMib(parseSmapsRollup(text));
  } catch {
    return null;
  }
}

// Pss_Anon + Pss_Shmem in MiB: what readOwnedRamMib counts
function countOwnedMib(fields: ReadonlyMap<string, number>): number {
  return Math.round(((fields.get('Pss_Anon') ?? 0) + (fields.get('Pss_Shmem') ?? 0)) / KIB_PER_MIB);
}

// The VM's anonymous and shmem pages counted in full, as if none were shared. KSM
// splits a merged page's Pss across the VMs that map it, and a write splits the
// page again: a wake reserve of this size holds when the guest writes them all.
export function readUnsharedRamMib(
  pid: number,
  apiSocket: string,
  procRoot = '/proc',
): number | null {
  const fields = readVmSmaps(pid, apiSocket, procRoot);

  return fields === null ? null : countUnsharedMib(fields);
}

export function countUnsharedMib(fields: ReadonlyMap<string, number>): number {
  return Math.round(
    ((fields.get('Anonymous') ?? 0) + (fields.get('Pss_Shmem') ?? 0)) / KIB_PER_MIB,
  );
}

// All the VM's resident pages (Rss), what `ps` shows; null as above
export function readRssMib(pid: number, apiSocket: string, procRoot = '/proc'): number | null {
  const fields = readVmSmaps(pid, apiSocket, procRoot);

  return fields === null ? null : Math.round((fields.get('Rss') ?? 0) / KIB_PER_MIB);
}

// what the governor counts and the whole resident size, from one read
export function readVmMemory(
  pid: number,
  apiSocket: string,
  procRoot = '/proc',
): { readonly ramMib: number | null; readonly rssMib: number | null } {
  const fields = readVmSmaps(pid, apiSocket, procRoot);

  if (fields === null) {
    return { ramMib: null, rssMib: null };
  }

  return {
    ramMib: countOwnedMib(fields),
    rssMib: Math.round((fields.get('Rss') ?? 0) / KIB_PER_MIB),
  };
}

function readVmSmaps(
  pid: number,
  apiSocket: string,
  procRoot: string,
): ReadonlyMap<string, number> | null {
  if (!isFirecrackerAlive(pid, apiSocket, procRoot)) {
    return null;
  }

  try {
    return parseSmapsRollup(readFileSync(`${procRoot}/${String(pid)}/smaps_rollup`, 'utf8'));
  } catch {
    return null;
  }
}

// utime + stime in clock ticks (USER_HZ, 100 on Linux), or null when gone
export function readCpuTicks(pid: number, procRoot = '/proc'): number | null {
  // fields after the parenthesised command name, starting at field 3
  const fields = readStatFields(pid, procRoot);

  return fields === null ? null : Number(fields[11]) + Number(fields[12]);
}

// the ids of the process's threads, from /proc/<pid>/task; null when gone
export function readThreadIds(pid: number, procRoot = '/proc'): number[] | null {
  try {
    return readdirSync(`${procRoot}/${String(pid)}/task`)
      .filter((name) => /^\d+$/v.test(name))
      .map(Number);
  } catch {
    return null;
  }
}
