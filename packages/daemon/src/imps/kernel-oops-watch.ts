import { closeSync, constants, openSync, readFileSync, readSync } from 'node:fs';

// what the record and the log say when a kernel oops killed the VM
export const KERNEL_OOPS_TRIGGER = 'a kernel oops killed firecracker';

// why the host needs a reboot, as /health, system.info and the metric say it
export const KERNEL_OOPS_REASON = 'a kernel oops';

// taint flag D: the kernel killed a task in an oops. Only a reboot clears it
const OOPS_TAINT = 128;

// What a read of taint flag D found: unknown when impd could not read or
// parse the taint mask, so the read proves neither an oops nor a reboot
type OopsFlag = 'clear' | 'set' | 'unknown';

// Whether the host's kernel has oopsed. An oops kills its task inside the
// kernel and keeps the locks and holds that task had, such as a ZFS hold on
// an imp's disk, until the host reboots.
export interface KernelOopsWatch {
  // reads the flag again until it reads set; once set it stays set
  readonly readFlag: () => OopsFlag;

  // the flag read set: an unknown read is no oops, so it never starts a hold
  readonly isOopsed: () => boolean;

  // when impd first read the flag set, after it had read it clear: the oops
  // came before then and since the clear read. Null without such a change
  readonly findOopsSeenAt: () => number | null;

  // the kernel's id for this boot, which a hold records: a hold of another
  // boot's id came before a reboot. Null when impd cannot read it
  readonly findBootId: () => string | null;

  // the imps whose Firecracker owned a thread an oops killed, by the thread
  // ids `listOwners` gives. Null when an oops names a thread no VM owns, or
  // impd cannot read the oops from the kernel log: then any VM may hold it
  readonly findOopsOwners: (
    listOwners: (threadId: number) => readonly string[],
  ) => ReadonlySet<string> | null;
}

// tests and a host without the file: the kernel never oopses
export const NO_KERNEL_OOPS: KernelOopsWatch = {
  readFlag: () => 'clear',
  isOopsed: () => false,
  findOopsSeenAt: () => null,
  findBootId: () => null,
  findOopsOwners: () => null,
};

// An unreadable or malformed file reads as unknown: it never starts a hold,
// and it never proves the reboot that clears one. `now` stamps the first read that finds the flag set.
export function createKernelOopsWatch(
  path = '/proc/sys/kernel/tainted',
  now: () => number = Date.now,
  bootIdPath = '/proc/sys/kernel/random/boot_id',
  kmsgPath = '/dev/kmsg',
): KernelOopsWatch {
  const seen: { clear: boolean; oopsedAt: number | null } = { clear: false, oopsedAt: null };

  // a boot keeps its id, so the first read that finds one stands
  const boot: { id: string | null } = { id: null };

  const readFlag = (): OopsFlag => {
    if (seen.oopsedAt !== null) {
      return 'set';
    }

    const taint = readTaint(path);

    if (taint === null) {
      return 'unknown';
    }

    if ((taint & OOPS_TAINT) === 0) {
      seen.clear = true;

      return 'clear';
    }

    seen.oopsedAt = now();

    return 'set';
  };

  const isOopsed = (): boolean => readFlag() === 'set';

  // each oops's owners, by its number, from the first look: the VM it hit
  // stops and leaves the sampler, but the oops stays its
  const owners = new Map<number, readonly string[]>();

  return {
    readFlag,
    isOopsed,
    findOopsSeenAt: () => (isOopsed() && seen.clear ? seen.oopsedAt : null),
    findBootId: () => {
      boot.id ??= readBootId(bootIdPath);

      return boot.id;
    },
    findOopsOwners: (listOwners) => {
      const threads = readKmsgOopsThreads(kmsgPath);

      if (threads === null) {
        return null;
      }

      const found = new Set<string>();

      for (const [oops, threadId] of threads) {
        const owned = owners.get(oops) ?? listOwners(threadId);

        owners.set(oops, owned);

        if (owned.length === 0) {
          return null;
        }

        for (const impId of owned) {
          found.add(impId);
        }
      }

      return found;
    },
  };
}

function readTaint(path: string): number | null {
  let text: string;

  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }

  // past 2^53 a number loses its low bits, flag D among them
  const taint = /^\d+$/v.test(text) ? Number(text) : null;

  return taint !== null && Number.isSafeInteger(taint) ? taint : null;
}

// the kernel's boot id is a UUID; anything else proves no boot
function readBootId(path: string): string | null {
  let text: string;

  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }

  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/v.test(text) ? text : null;
}

// the most a kmsg record holds is about 1 KiB of text and its dictionary
const KMSG_READ_BYTES = 16_384;

// An oops's first line ends in its number since boot: x86's
// "Oops: 0000 [#1] SMP", arm64's "Internal error: Oops: 0000000096000004 [#1] SMP"
const OOPS_HEADER = /: [\da-f]{4,16} \[#(?<oops>\d+)\]/v;

// the task line of the oops's register dump; the PID is the thread's id, and
// kernels from 6.12 put the UID before it
const OOPS_TASK = /^CPU: \d+ (?:UID: \d+ )?PID: (?<thread>\d+) Comm: /v;

// Each oops since boot and the thread it killed, from the kernel log. Null
// unless the log still holds every oops from the first, each with its task
// line: the kernel drops its oldest records once the log is full.
function readKmsgOopsThreads(path: string): ReadonlyMap<number, number> | null {
  const messages = readKmsgMessages(path);

  if (messages === null) {
    return null;
  }

  const threads = new Map<number, number | null>();

  let oops: number | null = null;

  for (const message of messages) {
    const header = OOPS_HEADER.exec(message)?.groups?.['oops'];

    if (header !== undefined) {
      oops = Number(header);

      threads.set(oops, null);
      continue;
    }

    const thread = OOPS_TASK.exec(message)?.groups?.['thread'];

    // the first task line after the header is the oops's own
    if (oops !== null && thread !== undefined && threads.get(oops) === null) {
      threads.set(oops, Number(thread));
    }
  }

  const found = new Map<number, number>();

  for (let number = 1; number <= threads.size; number += 1) {
    const thread = threads.get(number);

    if (thread === undefined || thread === null) {
      return null;
    }

    found.set(number, thread);
  }

  return found.size === 0 ? null : found;
}

// The text of each record in the kernel log, oldest first. /dev/kmsg gives
// one "<prio>,<seq>,<usec>,<flags>;<text>" record a read and EAGAIN at the
// end; a dictionary line under a record starts with a space.
function readKmsgMessages(path: string): string[] | null {
  let fd: number;

  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }

  const buffer = Buffer.alloc(KMSG_READ_BYTES);
  const chunks: string[] = [];

  try {
    for (;;) {
      const count = readKmsgChunk(fd, buffer);

      if (count === null) {
        return null;
      }

      if (count === 0) {
        break;
      }

      chunks.push(buffer.toString('utf8', 0, count));
    }
  } finally {
    closeSync(fd);
  }

  return chunks
    .join('')
    .split('\n')
    .filter((line) => !line.startsWith(' ') && line.includes(';'))
    .map((line) => line.slice(line.indexOf(';') + 1));
}

// bytes read, 0 at the end of the log, null on a failed read. EPIPE says the
// kernel overwrote the next record; the read after it goes on from the oldest
function readKmsgChunk(fd: number, buffer: Buffer): number | null {
  for (;;) {
    try {
      return readSync(fd, buffer);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : null;

      if (code === 'EAGAIN') {
        return 0;
      }

      if (code !== 'EPIPE') {
        return null;
      }
    }
  }
}
