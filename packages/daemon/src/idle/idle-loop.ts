import type { Config } from '../config';
import { listImps, updateImpActivity } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { Imps } from '../imps/imp-service';
import { readCpuTicks } from '../vmm/vm-stats';
import { checkIdle } from './check-idle';

// USER_HZ: /proc/<pid>/stat counts CPU time in 1/100 s on Linux
const TICKS_PER_SECOND = 100;

interface IdleLoopDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: Pick<Imps, 'isImpBusy' | 'readActivity' | 'tracker' | 'trySleepImp' | 'watchdog'>;
  readonly log: (message: string) => void;

  // the clock idle time is read on; Date.now by default
  readonly now?: () => number;
}

export interface IdleLoop {
  // one pass over the running imps: record activity, sleep the idle ones
  readonly runCheck: () => Promise<void>;
}

export function createIdleLoop(deps: IdleLoopDeps): IdleLoop {
  // per imp: the last CPU sample of its Firecracker
  const samples = new Map<string, { pid: number; ticks: number; at: number }>();

  const readCpuPercent = (imp: ImpRecord, pid: number, now: number): number | null => {
    const ticks = readCpuTicks(pid);
    const previous = samples.get(imp.id);

    if (ticks === null) {
      samples.delete(imp.id);

      return null;
    }

    samples.set(imp.id, { pid, ticks, at: now });

    if (previous?.pid !== pid || now <= previous.at) {
      return null;
    }

    const cpuSeconds = (ticks - previous.ticks) / TICKS_PER_SECOND;

    return (cpuSeconds / ((now - previous.at) / 1000)) * 100;
  };

  const checkImp = async (imp: ImpRecord): Promise<void> => {
    const pid = imp.pid;

    if (imp.state !== 'running' || pid === null || deps.imps.isImpBusy(imp.id)) {
      deps.imps.watchdog.forget(imp.id);

      return;
    }

    const now = (deps.now ?? Date.now)();
    const cpuPercent = readCpuPercent(imp, pid, now);

    // a busy or wedged agent: the other signals decide; a detached session
    // keeps the imp awake only through its CPU or TCP
    const activity = await deps.imps.readActivity(imp);

    deps.imps.watchdog.observe(imp, activity !== null);

    const tcpEstablished = activity?.tcp_established ?? 0;

    const decision = checkIdle(
      {
        execSessions: deps.imps.tracker.count(imp.id, 'exec'),
        proxyConnections: deps.imps.tracker.count(imp.id, 'proxy'),
        sshConnections: deps.imps.tracker.count(imp.id, 'ssh'),
        tunnelConnections: deps.imps.tracker.count(imp.id, 'tunnel'),
        tcpEstablished,
        cpuPercent,
        holdUntil: imp.holdUntil?.getTime() ?? null,
        lastActiveAt: imp.lastActiveAt.getTime(),
      },
      {
        now,
        idleTimeoutMs: deps.config.idleTimeoutS * 1000,
        cpuPercent: deps.config.idleCpuPercent,
      },
    );

    if (decision.activeReason !== null) {
      await updateImpActivity(deps.db, imp.id, new Date(now));

      return;
    }

    if (decision.sleep) {
      const idleS = Math.round((now - imp.lastActiveAt.getTime()) / 1000);
      const cpu = cpuPercent === null ? '?' : cpuPercent.toFixed(1);

      await deps.imps.trySleepImp(imp.id, `idle ${String(idleS)}s, cpu ${cpu}%`, {
        by: 'idle',
        seenActiveAt: imp.lastActiveAt.getTime(),
      });
    }
  };

  return {
    runCheck: async () => {
      const imps = await listImps(deps.db);

      for (const id of samples.keys()) {
        if (!imps.some((imp) => imp.id === id && imp.state === 'running')) {
          samples.delete(id);
        }
      }

      await Promise.all(imps.map((imp) => checkImp(imp)));
    },
  };
}
