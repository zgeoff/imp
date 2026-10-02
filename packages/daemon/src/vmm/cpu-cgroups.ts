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

// cpu.max's period: a limit of 1.5 cores is a quota of 150000 per 100000 µs
const PERIOD_US = 100_000;

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

  // makes the cgroup with the imp's settings; null when not enforced
  readonly setup: (impId: string, cpu: CpuSettings) => ImpCgroup | null;

  // new settings on a cgroup a VM may be running in
  readonly apply: (impId: string, cpu: CpuSettings) => void;

  // a VM impd re-adopts joins its cgroup when it is anywhere else
  readonly adopt: (impId: string, pid: number, cpu: CpuSettings) => void;

  // after the VM exited; waits out the moment its exited Firecracker still
  // counts as inside
  readonly remove: (impId: string) => Promise<void>;

  // removes the cgroup of every id not in `impIds`; returns those ids
  readonly removeOrphans: (impIds: ReadonlySet<string>) => string[];
  readonly readCpuStat: (impId: string) => CpuStat | null;
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

export function createCpuCgroups(options: CpuCgroupOptions): CpuCgroups {
  const imps = join(options.root, 'imps');
  const procRoot = options.procRoot ?? '/proc';
  const isEnforced = isCpuDelegated(imps);
  const findDir = (impId: string): string => join(imps, impId);

  const writeSettings = (impId: string, cpu: CpuSettings, limit: number | null): void => {
    writeFileSync(join(findDir(impId), 'cpu.weight'), String(cpu.weight));
    writeFileSync(join(findDir(impId), 'cpu.max'), formatCpuMax(limit));
  };

  // a failed write costs the limit, never the boot or the wake
  const tryWrite = (impId: string, what: string, write: () => void): void => {
    try {
      write();
    } catch (error) {
      options.log(`impd: cgroup ${impId}: ${what}: ${readErrorMessage(error)}`);
    }
  };

  const setup = (impId: string, cpu: CpuSettings): ImpCgroup | null => {
    if (!isEnforced) {
      return null;
    }

    try {
      mkdirSync(findDir(impId), { recursive: true });
      writeSettings(impId, cpu, cpu.limit);
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
    setup,
    apply: (impId, cpu) => {
      if (isEnforced && existsSync(findDir(impId))) {
        tryWrite(impId, 'apply the limit', () => {
          writeSettings(impId, cpu, cpu.limit);
        });
      }
    },
    adopt: (impId, pid, cpu) => {
      if (!isEnforced || readProcessCgroup(procRoot, pid) === `/imps/${impId}`) {
        return;
      }

      const cgroup = setup(impId, cpu);

      if (cgroup !== null) {
        tryWrite(impId, `move pid ${String(pid)}`, () => {
          writeFileSync(cgroup.procsPath, String(pid));
        });
      }
    },
    remove: async (impId) => {
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

// the entrypoint hands the cpu controller to imps/ only in a private
// cgroup v2 namespace
function isCpuDelegated(imps: string): boolean {
  try {
    return readFileSync(join(imps, 'cgroup.subtree_control'), 'utf8').split(/\s+/).includes('cpu');
  } catch {
    return false;
  }
}

// the cgroup v2 path of a process, such as /imps/<id>; null when gone
function readProcessCgroup(procRoot: string, pid: number): string | null {
  try {
    const text = readFileSync(join(procRoot, String(pid), 'cgroup'), 'utf8');

    return text.trim().replace(/^0::/, '');
  } catch {
    return null;
  }
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EBUSY';
}
