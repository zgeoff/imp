import { readFileSync } from 'node:fs';

// what the record and the log say when a kernel oops killed the VM
export const KERNEL_OOPS_TRIGGER = 'a kernel oops killed firecracker';

// why the host needs a reboot, as /health, system.info and the metric say it
export const KERNEL_OOPS_REASON = 'a kernel oops';

// taint flag D: the kernel killed a task in an oops. Only a reboot clears it
const OOPS_TAINT = 128;

// Whether the host's kernel has oopsed. An oops kills its task inside the
// kernel and keeps the locks and holds that task had, such as a ZFS hold on
// an imp's disk, until the host reboots.
export interface KernelOopsWatch {
  // reads the flag again while it is clear; once set it stays set
  readonly isOopsed: () => boolean;

  // when impd first read the flag set, after it had read it clear: the oops
  // came before then and since the clear read. Null without such a change
  readonly findOopsSeenAt: () => number | null;
}

// tests and a host without the file: the kernel never oopses
export const NO_KERNEL_OOPS: KernelOopsWatch = {
  isOopsed: () => false,
  findOopsSeenAt: () => null,
};

// An unreadable or malformed file reads as clear, so it never starts a hold.
// `now` stamps the first read that finds the flag set.
export function createKernelOopsWatch(
  path = '/proc/sys/kernel/tainted',
  now: () => number = Date.now,
): KernelOopsWatch {
  const seen: { clear: boolean; oopsedAt: number | null } = { clear: false, oopsedAt: null };

  const isOopsed = (): boolean => {
    if (seen.oopsedAt !== null) {
      return true;
    }

    const taint = readTaint(path);

    if (taint === null) {
      return false;
    }

    if ((taint & OOPS_TAINT) === 0) {
      seen.clear = true;

      return false;
    }

    seen.oopsedAt = now();

    return true;
  };

  return {
    isOopsed,
    findOopsSeenAt: () => (isOopsed() && seen.clear ? seen.oopsedAt : null),
  };
}

function readTaint(path: string): number | null {
  let text: string;

  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }

  return /^\d+$/v.test(text) ? Number(text) : null;
}
