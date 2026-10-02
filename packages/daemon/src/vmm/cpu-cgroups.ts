import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CpuSettings } from '../db/imps';
import { readErrorMessage } from '../read-error-message';
import { readProcessCgroup } from './process-owner';

// cpu.max's period: a limit of 1.5 cores is a quota of 150000 per 100000 µs
const PERIOD_US = 100_000;

// Room above the guest's memory for Firecracker and the page cache of its
// disk and snapshot I/O, which the kernel reclaims at memory.max before any
// OOM kill (docs/architecture/daemon.md#cgroups)
const MEMORY_MIN_OVERHEAD_MIB = 256;
const MEMORY_OVERHEAD_DIVISOR = 8;
const BYTES_PER_MIB = 1024 * 1024;

// rmdir answers EBUSY until the kernel lets go of an exited process
const REMOVE_TRIES = 40;
const REMOVE_WAIT_MS = 50;

// Each imp's Firecracker in imps/<id> under the container's cgroup root
// (host/scripts/setup-cgroups.sh), the layout the jailer's --parent-cgroup
// makes, so #27 replaces only this writer.
export interface ImpCgroup {
  // a new process writes its own pid here to join before it runs
  readonly procsPath: string;

  // no limit while a snapshot is made or loaded, then the imp's again: a
  // throttled VMM thread stretches a pause past the guest's patience
  readonly liftLimit: () => void;
  readonly applyLimit: () => void;
}

export interface CpuStat {
  readonly usageUsec: number;
  readonly throttledUsec: number;
}

export interface CpuCgroups {
  // false without a private cgroup v2 namespace: limits are kept, not applied
  readonly isEnforced: boolean;

  // whether the memory controller is on too, for each VM's memory limit
  readonly isMemoryEnforced: boolean;

  // makes the cgroup with the imp's settings; null when not enforced
  readonly setup: (impId: string, cpu: CpuSettings, memoryMib: number) => ImpCgroup | null;

  // new settings on a cgroup a VM may be running in
  readonly apply: (impId: string, cpu: CpuSettings) => void;

  // a VM impd re-adopts joins its cgroup when it is anywhere else
  readonly adopt: (impId: string, pid: number, cpu: CpuSettings, memoryMib: number) => void;

  // after the VM exited; waits out the moment its exited Firecracker still
  // counts as inside
  readonly remove: (impId: string) => Promise<void>;

  // A sleep, a failed sleep and a repair to sleeping keep it, empty and
  // harmless: setup reuses it and writes the settings again, the spawn's
  // baseline hides its old cpu.stat, and a destroy or a stop removes it.

  // the guest's memory, base plus hot-plugged, for its memory limit: raised
  // before a plug, lowered once an unplug's RSS has fallen
  readonly setGuestMib: (impId: string, guestMib: number) => void;

  // removes the cgroup of every id not in `impIds`; returns those ids
  readonly removeOrphans: (impIds: ReadonlySet<string>) => string[];
  readonly readCpuStat: (impId: string) => CpuStat | null;

  // how often the kernel killed a process in the cgroup for its memory
  // limit (memory.events oom_kill); null without the file
  readonly readOomKills: (impId: string) => number | null;

  // whether it did since the last setup or adopt, for a VM found dead: a
  // cgroup that a busy remove kept still counts an older VM's kill
  readonly hasOomKillSinceStart: (impId: string) => boolean;

  // SIGKILL to every process in the cgroup at once (cgroup.kill), so one that
  // forked from Firecracker cannot outlive it; nothing without the cgroup
  readonly kill: (impId: string) => void;
}

interface CpuCgroupOptions {
  // /sys/fs/cgroup; a test passes a directory of its own
  readonly root: string;
  readonly log: (message: string) => void;

  // where /proc/<pid>/cgroup is read; /proc by default
  readonly procRoot?: string;
}

export function formatCpuMax(limit: number | null): string {
  return limit === null
    ? `max ${String(PERIOD_US)}`
    : `${String(Math.round(limit * PERIOD_US))} ${String(PERIOD_US)}`;
}

// cpu.stat's usage_usec and throttled_usec; null without the fields
export function parseCpuStat(text: string): CpuStat | null {
  const fields = new Map(
    text
      .split('\n')
      .map((line) => line.split(' '))
      .map(([key, value]) => [key ?? '', Number(value)] as const),
  );

  const usageUsec = fields.get('usage_usec');

  if (usageUsec === undefined || Number.isNaN(usageUsec)) {
    return null;
  }

  return { usageUsec, throttledUsec: fields.get('throttled_usec') ?? 0 };
}

// memory.max: the guest plus 256 MiB, or an eighth of it when that is more
export function buildMemoryMax(memoryMib: number): string {
  const overhead = Math.max(
    MEMORY_MIN_OVERHEAD_MIB,
    Math.ceil(memoryMib / MEMORY_OVERHEAD_DIVISOR),
  );

  return String((memoryMib + overhead) * BYTES_PER_MIB);
}

// memory.events' oom_kill; null without the field
export function parseOomKills(text: string): number | null {
  const match = /^oom_kill (?<count>\d+)$/m.exec(text);

  return match?.groups === undefined ? null : Number(match.groups['count']);
}

export function createCpuCgroups(options: CpuCgroupOptions): CpuCgroups {
  const imps = join(options.root, 'imps');
  const procRoot = options.procRoot ?? '/proc';
  const isEnforced = isControllerDelegated(imps, 'cpu');
  const isMemoryEnforced = isEnforced && isControllerDelegated(imps, 'memory');
  const findDir = (impId: string): string => join(imps, impId);

  const guestMibs = new Map<string, number>();

  // oom_kill when the VM in each cgroup started or was adopted
  const oomBaselines = new Map<string, number>();

  const readOomKills = (impId: string): number | null => {
    try {
      const events = readFileSync(join(findDir(impId), 'memory.events'), 'utf8');

      return parseOomKills(events);
    } catch {
      return null;
    }
  };

  const setOomBaseline = (impId: string): void => {
    oomBaselines.set(impId, readOomKills(impId) ?? 0);
  };

  const writeSettings = (impId: string, cpu: CpuSettings, limit: number | null): void => {
    writeFileSync(join(findDir(impId), 'cpu.weight'), String(cpu.weight));
    writeFileSync(join(findDir(impId), 'cpu.max'), formatCpuMax(limit));
  };

  // No swap, and an OOM kill takes the whole VM, never one thread of it. No
  // memory.high: its throttling halved a guest's disk throughput.
  const writeMemory = (impId: string): void => {
    const guestMib = guestMibs.get(impId);

    if (!isMemoryEnforced || guestMib === undefined) {
      return;
    }

    const dir = findDir(impId);

    writeFileSync(join(dir, 'memory.max'), buildMemoryMax(guestMib));
    writeFileSync(join(dir, 'memory.high'), 'max');
    writeFileSync(join(dir, 'memory.swap.max'), '0');
    writeFileSync(join(dir, 'memory.oom.group'), '1');
  };

  // a failed write costs the limit, never the boot or the wake
  const tryWrite = (impId: string, what: string, write: () => void): void => {
    try {
      write();
    } catch (error) {
      options.log(`impd: cgroup ${impId}: ${what}: ${readErrorMessage(error)}`);
    }
  };

  const setup = (impId: string, cpu: CpuSettings, memoryMib: number): ImpCgroup | null => {
    if (!isEnforced) {
      return null;
    }

    try {
      // a size setGuestMib gave outlives a sleep; a stop forgets it
      if (!guestMibs.has(impId)) {
        guestMibs.set(impId, memoryMib);
      }

      mkdirSync(findDir(impId), { recursive: true });
      setOomBaseline(impId);
      writeSettings(impId, cpu, cpu.limit);
      writeMemory(impId);
    } catch (error) {
      options.log(`impd: cgroup ${impId}: ${readErrorMessage(error)}; this VM runs unlimited`);

      return null;
    }

    return {
      procsPath: join(findDir(impId), 'cgroup.procs'),
      liftLimit: () => {
        tryWrite(impId, 'lift the limit', () => {
          writeSettings(impId, cpu, null);
        });
      },
      applyLimit: () => {
        tryWrite(impId, 'apply the limit', () => {
          writeSettings(impId, cpu, cpu.limit);
        });
      },
    };
  };

  return {
    isEnforced,
    isMemoryEnforced,
    setup,
    apply: (impId, cpu) => {
      if (isEnforced && existsSync(findDir(impId))) {
        tryWrite(impId, 'apply the limit', () => {
          writeSettings(impId, cpu, cpu.limit);
        });
      }
    },
    adopt: (impId, pid, cpu, memoryMib) => {
      if (!isEnforced) {
        return;
      }

      if (readProcessCgroup(pid, procRoot) === `/imps/${impId}`) {
        setOomBaseline(impId);

        return;
      }

      const cgroup = setup(impId, cpu, memoryMib);

      if (cgroup !== null) {
        tryWrite(impId, `move pid ${String(pid)}`, () => {
          writeFileSync(cgroup.procsPath, String(pid));
        });
      }
    },
    setGuestMib: (impId, guestMib) => {
      guestMibs.set(impId, guestMib);

      if (isMemoryEnforced && existsSync(findDir(impId))) {
        tryWrite(impId, 'set the memory limit', () => {
          writeMemory(impId);
        });
      }
    },
    remove: async (impId) => {
      guestMibs.delete(impId);
      oomBaselines.delete(impId);

      if (!isEnforced) {
        return;
      }

      for (let attempt = 1; existsSync(findDir(impId)); attempt += 1) {
        try {
          rmdirSync(findDir(impId));

          return;
        } catch (error) {
          if (!isBusy(error) || attempt === REMOVE_TRIES) {
            options.log(`impd: cgroup ${impId}: remove: ${readErrorMessage(error)}`);

            return;
          }
        }

        await Bun.sleep(REMOVE_WAIT_MS);
      }
    },
    removeOrphans: (impIds) => {
      if (!isEnforced) {
        return [];
      }

      const orphans = readdirSync(imps, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !impIds.has(entry.name))
        .map((entry) => entry.name);

      for (const impId of orphans) {
        tryWrite(impId, 'remove an orphan', () => {
          rmdirSync(findDir(impId));
        });
      }

      return orphans;
    },
    kill: (impId) => {
      if (isEnforced && existsSync(findDir(impId))) {
        tryWrite(impId, 'kill', () => {
          writeFileSync(join(findDir(impId), 'cgroup.kill'), '1');
        });
      }
    },
    readOomKills,
    hasOomKillSinceStart: (impId) => {
      const baseline = oomBaselines.get(impId);

      return baseline !== undefined && (readOomKills(impId) ?? 0) > baseline;
    },
    readCpuStat: (impId) => {
      try {
        const stat = readFileSync(join(findDir(impId), 'cpu.stat'), 'utf8');

        return parseCpuStat(stat);
      } catch {
        return null;
      }
    },
  };
}

// the entrypoint hands controllers to imps/ only in a private cgroup v2
// namespace
function isControllerDelegated(imps: string, controller: string): boolean {
  try {
    const delegated = readFileSync(join(imps, 'cgroup.subtree_control'), 'utf8');

    return delegated.split(/\s+/).includes(controller);
  } catch {
    return false;
  }
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EBUSY';
}
