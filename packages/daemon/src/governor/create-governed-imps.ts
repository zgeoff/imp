import { listImps } from '../db/imps';
import { createImpService } from '../imps/imp-service';
import type { ImpServiceDeps, Imps } from '../imps/imp-service';
import { createMemoryController } from '../memory/memory-controller';
import type { MemoryController } from '../memory/memory-controller';
import { NO_MEMORY_LIMIT } from '../memory/memory-limit';
import { createPluggedSizes } from '../memory/plugged-sizes';
import { printLog } from '../process/print-log';
import { buildImpPaths } from '../storage/data-layout';
import { readKsmProfitMib } from '../vmm/ksm';
import { readOwnedRamMib } from '../vmm/vm-stats';
import { createRamGovernor } from './ram-governor';
import type { RamAdmission, RamGovernor } from './ram-governor';

type GovernedDeps = Omit<ImpServiceDeps, 'admission'>;

// The imp service and the RAM governor need each other: the service asks the
// governor before every boot, the governor sleeps imps through the service.
export function createGovernedImps(deps: GovernedDeps): {
  readonly imps: Imps;
  readonly governor: RamGovernor;
  readonly memory: MemoryController;
} {
  const holder: { governor: RamGovernor | null } = { governor: null };
  const readRamMib = deps.readRamMib ?? readOwnedRamMib;
  const log = deps.log ?? printLog;

  // the governor exists before any request reaches the service
  const admission: RamAdmission = {
    admit: (request) => holder.governor?.admit(request) ?? Promise.resolve(),
    release: (id) => {
      holder.governor?.release(id);
    },
  };

  const pluggedSizes = createPluggedSizes();
  const imps = createImpService({ ...deps, readRamMib, admission, pluggedSizes });
  const ksm = deps.config.ksm;
  const readProfitMib = deps.readKsmProfitMib ?? readKsmProfitMib;

  // what KSM saves in the awake VMs only, not in the host's other processes;
  // a VM's profit is negative while its metadata outweighs what it merged
  const readHeadroomMib = async (pids: readonly number[]): Promise<number> => {
    if (ksm === null) {
      return 0;
    }

    const profits = await Promise.all(pids.map((pid) => readProfitMib(pid)));

    const profitMib = profits.reduce<number>((sum, mib) => sum + (mib ?? 0), 0);

    return Math.ceil((Math.max(profitMib, 0) * ksm.headroomPercent) / 100);
  };

  // an open exec session or proxied request pins the imp, like a hold
  const isBusy = (id: string) => imps.isImpBusy(id) || imps.tracker.count(id) > 0;

  // elastic guests grow and shrink here (docs/architecture/memory.md)
  const memory = createMemoryController({
    listElastic: async () => {
      const listed = await listImps(deps.db);

      return listed.flatMap((imp) =>
        imp.state === 'running' && imp.pid !== null && imp.maxMemoryMib > imp.memoryMib
          ? [
              {
                id: imp.id,
                name: imp.name,
                pid: imp.pid,
                memoryMib: imp.memoryMib,
                maxMemoryMib: imp.maxMemoryMib,
                paths: buildImpPaths(deps.config.dataDir, imp.id),
              },
            ]
          : [],
      );
    },
    vms: deps.vms,
    isLocked: (id) => imps.isImpBusy(id),
    isBusy,
    tryWhileRunning: imps.tryWhileRunning,
    admitGrow: (request) => holder.governor?.admitGrow(request) ?? Promise.resolve(true),
    releaseGrow: admission.release,
    limit: deps.memoryLimit ?? NO_MEMORY_LIMIT,
    readRamMib: (imp) => readRamMib(imp.pid, imp.paths.apiSocket),
    setPluggedMib: pluggedSizes.write,
    log,
    ...(deps.now !== undefined && { now: deps.now }),
  });

  const governor = createRamGovernor({
    budgetMib: deps.config.ramBudgetMib,
    listAwake: async () => {
      const listed = await listImps(deps.db);

      return listed.flatMap((imp) =>
        imp.state === 'running' && imp.pid !== null
          ? [
              {
                id: imp.id,
                name: imp.name,
                pid: imp.pid,
                apiSocket: buildImpPaths(deps.config.dataDir, imp.id).apiSocket,
                lastActiveAt: imp.lastActiveAt.getTime(),
                holdUntil: imp.holdUntil?.getTime() ?? null,
              },
            ]
          : [],
      );
    },
    readRamMib,
    readHeadroomMib,

    isBusy,
    trySleepImp: imps.trySleepImp,
    readDiskFullError: imps.readDiskFullError,
    reclaim: memory.reclaimIdle,
    log,
    events: imps.events,
    ...(deps.now !== undefined && { now: deps.now }),
  });

  holder.governor = governor;

  return { imps, governor, memory };
}
