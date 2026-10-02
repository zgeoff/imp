import { readFileSync } from 'node:fs';

const KSM_DIR = '/sys/kernel/mm/ksm';
const PAGE_BYTES = 4096;
const MIB = 1024 ** 2;

// Guest memory is one or two large private mappings; Firecracker's own are smaller
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

// Whether every large private writable mapping in /proc/<pid>/smaps text
// carries `mg` (VM_MERGEABLE); null when there is none
export function checkMergeableMappings(smaps: string): boolean | null {
  const mappings: { large: boolean; mergeable: boolean }[] = [];

  for (const line of smaps.split('\n')) {
    const header = /^(?<start>[\da-f]+)-(?<end>[\da-f]+) rw-p /u.exec(line);

    if (header?.groups !== undefined) {
      const bytes =
        Number.parseInt(header.groups['end'] ?? '0', 16) -
        Number.parseInt(header.groups['start'] ?? '0', 16);

      mappings.push({ large: bytes >= GUEST_MAPPING_MIN_BYTES, mergeable: false });
      continue;
    }

    const last = mappings.at(-1);

    if (line.startsWith('VmFlags:') && last !== undefined) {
      last.mergeable = line.split(/\s+/u).includes('mg');
    }

    // a mapping that is not rw-p ends the one before it
    if (/^[\da-f]+-[\da-f]+ /u.test(line)) {
      mappings.push({ large: false, mergeable: true });
    }
  }

  const guest = mappings.filter((mapping) => mapping.large);

  if (guest.length === 0) {
    return null;
  }

  return guest.every((mapping) => mapping.mergeable);
}

// Whether KSM may merge the VM's guest memory; null when its smaps cannot be read
export function checkGuestMemoryMergeable(pid: number): boolean | null {
  try {
    return checkMergeableMappings(readFileSync(`/proc/${String(pid)}/smaps`, 'utf8'));
  } catch {
    return null;
  }
}
