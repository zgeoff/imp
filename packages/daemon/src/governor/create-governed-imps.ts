import { listImps } from '../db/imps';
import { createImpService } from '../imps/imp-service';
import type { ImpServiceDeps, Imps } from '../imps/imp-service';
import { printLog } from '../process/print-log';
import { buildImpPaths } from '../storage/data-layout';
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

    // an open exec session or proxied request pins the imp, like a hold
    isBusy: (id) => imps.isImpBusy(id) || imps.tracker.count(id) > 0,
    trySleepImp: imps.trySleepImp,
    log,
    ...(deps.now !== undefined && { now: deps.now }),
  });

  holder.governor = governor;

  return { imps, governor };
}
