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

  // whether impd saw the flag clear before it saw it set: an oops since then
  readonly hasOopsedSinceClear: () => boolean;
}

// tests and a host without the file: the kernel never oopses
export const NO_KERNEL_OOPS: KernelOopsWatch = {
  isOopsed: () => false,
  hasOopsedSinceClear: () => false,
};

// An unreadable or malformed file reads as clear, so it never starts a hold.
export function createKernelOopsWatch(path = '/proc/sys/kernel/tainted'): KernelOopsWatch {
  const seen = { clear: false, oopsed: false };

  const isOopsed = (): boolean => {
    if (seen.oopsed) {
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

    seen.oopsed = true;

    return true;
  };

  return {
    isOopsed,
    hasOopsedSinceClear: () => isOopsed() && seen.clear,
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
