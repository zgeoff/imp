import { listImps } from '../db/imps';
import { createImpService } from '../imps/imp-service';
import type { ImpServiceDeps, Imps } from '../imps/imp-service';
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

  const imps = createImpService({ ...deps, readRamMib, admission });
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

    // an open exec session or proxied request pins the imp, like a hold
    isBusy: (id) => imps.isImpBusy(id) || imps.tracker.count(id) > 0,
    trySleepImp: imps.trySleepImp,
    readDiskFullError: imps.readDiskFullError,
    log,
    events: imps.events,
    ...(deps.now !== undefined && { now: deps.now }),
  });

  holder.governor = governor;

  return { imps, governor };
}
