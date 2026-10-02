import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const KSM_DIR = '/sys/kernel/mm/ksm';
const PAGE_BYTES = 4096;
const MIB = 1024 ** 2;

// Guest memory is one backing's private mappings of this much or more in all;
// Firecracker's own are smaller
const GUEST_MAPPING_MIN_BYTES = 64 * MIB;

// 6.7 keeps the merge flag across exec (3c6f33b7273a); 6.10 also has ksmd
// scan the exec'd process (3a9e567ca45f)
const MIN_KERNEL = { major: 6, minor: 10 } as const;

export interface KsmHostStats {
  // whether ksmd runs (/sys/kernel/mm/ksm/run is 1)
  readonly running: boolean;

  // the pages merged away, and that less KSM's own metadata; general_profit
  // goes negative while little is merged
  readonly sharedMib: number;
  readonly profitMib: number;

  // zero pages merged into the kernel's zero page (use_zero_pages)
  readonly zeroMib: number;
}

// Why IMP_KSM cannot run on this kernel release (`uname -r`), or null when it can
export function checkKsmKernel(release: string): string | null {
  const match = /^(?<major>\d+)\.(?<minor>\d+)/u.exec(release);
  const major = Number(match?.groups?.['major'] ?? Number.NaN);
  const minor = Number(match?.groups?.['minor'] ?? Number.NaN);

  const isNewEnough =
    major > MIN_KERNEL.major || (major === MIN_KERNEL.major && minor >= MIN_KERNEL.minor);

  if (isNewEnough) {
    return null;
  }

  return `IMP_KSM needs Linux ${String(MIN_KERNEL.major)}.${String(MIN_KERNEL.minor)} or later, which keeps the merge flag across exec and scans the exec'd process; this host runs ${release}`;
}

// Why impd cannot start with IMP_KSM on this host, or null when it can
export function checkKsmHost(release: string, stats: KsmHostStats | null): string | null {
  const kernel = checkKsmKernel(release);

  if (kernel !== null) {
    return kernel;
  }

  return stats === null ? `IMP_KSM needs a kernel built with CONFIG_KSM (no ${KSM_DIR})` : null;
}

// null when the kernel has no KSM
export function readKsmHostStats(dir = KSM_DIR): KsmHostStats | null {
  try {
    const readCount = (name: string): number => {
      try {
        return Number(readFileSync(`${dir}/${name}`, 'utf8').trim());
      } catch {
        return 0;
      }
    };

    const run = readFileSync(`${dir}/run`, 'utf8').trim();

    return {
      running: run === '1',
      sharedMib: Math.round((readCount('pages_sharing') * PAGE_BYTES) / MIB),
      profitMib: Math.round(readCount('general_profit') / MIB),
      zeroMib: Math.round((readCount('ksm_zero_pages') * PAGE_BYTES) / MIB),
    };
  } catch {
    return null;
  }
}

// Whether every private writable mapping of the guest's memory in
// /proc/<pid>/smaps text carries `mg` (VM_MERGEABLE); null when none shows.
// A restore's memory, its template's mem file, can come in several mappings.
export function checkMergeableMappings(smaps: string): boolean | null {
  const mappings: { backing: string; bytes: number; mergeable: boolean }[] = [];
  let current: (typeof mappings)[number] | null = null;

  for (const line of smaps.split('\n')) {
    const header =
      /^(?<start>[\da-f]+)-(?<end>[\da-f]+) (?<perms>\S+) \S+ \S+ \S+\s*(?<backing>.*)$/u.exec(
        line,
      );

    if (header?.groups !== undefined) {
      const bytes =
        Number.parseInt(header.groups['end'] ?? '0', 16) -
        Number.parseInt(header.groups['start'] ?? '0', 16);

      // only rw-p memory can be guest memory; others end the one before
      current =
        header.groups['perms'] === 'rw-p'
          ? { backing: header.groups['backing'] ?? '', bytes, mergeable: false }
          : null;

      if (current !== null) {
        mappings.push(current);
      }
    } else if (line.startsWith('VmFlags:') && current !== null) {
      current.mergeable = line.split(/\s+/u).includes('mg');
    }
  }

  // guest memory: every mapping of a backing, none for anonymous memory, that
  // maps GUEST_MAPPING_MIN_BYTES or more in all
  const bytesByBacking = new Map<string, number>();

  for (const mapping of mappings) {
    bytesByBacking.set(mapping.backing, (bytesByBacking.get(mapping.backing) ?? 0) + mapping.bytes);
  }

  const guest = mappings.filter(
    (mapping) => (bytesByBacking.get(mapping.backing) ?? 0) >= GUEST_MAPPING_MIN_BYTES,
  );

  if (guest.length === 0) {
    return null;
  }

  return guest.every((mapping) => mapping.mergeable);
}

// /proc/<pid>/ksm_stat: `name value` lines, `name: value` for the flags (6.12)
export function parseKsmStat(text: string): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();

  for (const line of text.split('\n')) {
    const match = /^(?<name>\w+):?\s+(?<value>\S+)$/u.exec(line.trim());

    if (match?.groups !== undefined) {
      fields.set(match.groups['name'] ?? '', match.groups['value'] ?? '');
    }
  }

  return fields;
}

async function readKsmStat(pid: number): Promise<ReadonlyMap<string, string> | null> {
  try {
    const text = await readFile(`/proc/${String(pid)}/ksm_stat`, 'utf8');

    return parseKsmStat(text);
  } catch {
    return null;
  }
}

// Whether KSM may merge the VM's guest memory; null when that cannot be read.
// ksm_stat's ksm_merge_any (6.12) answers at once; before it, the smaps flags.
export async function checkGuestMemoryMergeable(pid: number): Promise<boolean | null> {
  const stat = await readKsmStat(pid);

  const mergeAny = stat?.get('ksm_merge_any');

  if (mergeAny !== undefined) {
    return mergeAny === 'yes';
  }

  try {
    const smaps = await readFile(`/proc/${String(pid)}/smaps`, 'utf8');

    return checkMergeableMappings(smaps);
  } catch {
    return null;
  }
}

// What KSM saves in this process less its metadata (ksm_process_profit), in
// MiB; negative while little is merged, null when unreadable
export async function readKsmProfitMib(pid: number): Promise<number | null> {
  const stat = await readKsmStat(pid);

  const profit = stat?.get('ksm_process_profit');

  return profit === undefined ? null : Number(profit) / MIB;
}
