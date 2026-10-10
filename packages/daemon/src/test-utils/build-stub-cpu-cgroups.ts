import type { CpuSettings } from '../db/imps';
import type { CpuCgroups, CpuStat, ImpCgroup } from '../vmm/cpu-cgroups';

interface StubCgroup {
  cpu: CpuSettings;
  memoryMib: number;
  guestMib: number | null;
  readonly pids: number[];

  // the OOM kill count when its VM started, for hasOomKillSinceStart
  oomKillsAtStart: number;
}

interface StubCpuCgroupsOptions {
  // false: a host without a delegated cpu controller, where setup makes none
  readonly isEnforced?: boolean;
  readonly isMemoryEnforced?: boolean;
}

function formatCpu(cpu: Readonly<CpuSettings>): string {
  return `${String(cpu.limit)}/${String(cpu.weight)}`;
}

// The cgroup tree under /sys/fs/cgroup/imps in memory. `calls` records each
// change as `verb impId [detail]`; a test sets an imp's OOM kill count and
// cpu.stat through `oomKills` and `cpuStats`.
export function buildStubCpuCgroups(options: StubCpuCgroupsOptions = {}) {
  const isEnforced = options.isEnforced ?? true;

  const groups = new Map<string, StubCgroup>();

  const calls: string[] = [];

  const oomKills = new Map<string, number>();
  const cpuStats = new Map<string, CpuStat>();

  const startGroup = (impId: string, cpu: CpuSettings, memoryMib: number): StubCgroup => {
    const known = groups.get(impId);
    const group = known ?? { cpu, memoryMib, guestMib: null, pids: [], oomKillsAtStart: 0 };

    group.cpu = cpu;
    group.memoryMib = memoryMib;
    group.oomKillsAtStart = oomKills.get(impId) ?? 0;

    groups.set(impId, group);

    return group;
  };

  const cgroups: CpuCgroups = {
    isEnforced,
    isMemoryEnforced: isEnforced && options.isMemoryEnforced === true,
    setup: (impId, cpu, memoryMib): ImpCgroup | null => {
      calls.push(`setup ${impId} ${formatCpu(cpu)}`);

      if (!isEnforced) {
        return null;
      }

      startGroup(impId, cpu, memoryMib);

      return {
        procsPath: `/sys/fs/cgroup/imps/${impId}/cgroup.procs`,
        liftLimit: () => {
          calls.push(`lift ${impId}`);
        },
        applyLimit: () => {
          calls.push(`limit ${impId}`);
        },
      };
    },
    apply: (impId, cpu) => {
      calls.push(`apply ${impId} ${formatCpu(cpu)}`);

      const group = groups.get(impId);

      if (group !== undefined) {
        group.cpu = cpu;
      }
    },
    adopt: (impId, pid, cpu, memoryMib) => {
      calls.push(`adopt ${impId} ${String(pid)}`);

      if (isEnforced) {
        startGroup(impId, cpu, memoryMib).pids.push(pid);
      }
    },
    remove: (impId) => {
      calls.push(`remove ${impId}`);
      groups.delete(impId);

      return Promise.resolve();
    },
    setGuestMib: (impId, guestMib) => {
      calls.push(`memory ${impId} ${String(guestMib)}`);

      const group = groups.get(impId);

      if (group !== undefined) {
        group.guestMib = guestMib;
      }
    },
    removeOrphans: (impIds) => {
      const orphans = [...groups.keys()].filter((impId) => !impIds.has(impId));

      for (const impId of orphans) {
        calls.push(`remove ${impId}`);
        groups.delete(impId);
      }

      return orphans;
    },

    // a new cgroup's cpu.stat counts from zero, as the kernel's does
    readCpuStat: (impId) =>
      groups.has(impId) ? (cpuStats.get(impId) ?? { usageUsec: 0, throttledUsec: 0 }) : null,
    readOomKills: (impId) => (groups.has(impId) ? (oomKills.get(impId) ?? 0) : null),
    hasOomKillSinceStart: (impId) => {
      const group = groups.get(impId);

      return group !== undefined && (oomKills.get(impId) ?? 0) > group.oomKillsAtStart;
    },
    kill: (impId) => {
      calls.push(`kill ${impId}`);
    },
  };

  return {
    cgroups,
    calls,
    oomKills,
    cpuStats,

    // the imps that have a cgroup now
    listGroups: (): string[] => [...groups.keys()].toSorted(),

    // what an imp's cgroup holds, or null without one
    readGroup: (impId: string) => {
      const group = groups.get(impId);

      return group === undefined
        ? null
        : {
            cpu: group.cpu,
            memoryMib: group.memoryMib,
            guestMib: group.guestMib,
            pids: [...group.pids],
          };
    },
  };
}
