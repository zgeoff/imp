import { listImps } from '../db/imps';
import type { ImpRuntime } from '../imps/imp-runtime';
import { createImpService } from '../imps/imp-service';
import type { ImpServiceDeps, Imps } from '../imps/imp-service';
import { printLog } from '../process/print-log';
import { buildImpPaths } from '../storage/data-layout';
import { readOwnedRamMib } from '../vmm/vm-stats';
import { createRamGovernor } from './ram-governor';
import type { RamGovernor } from './ram-governor';

type GovernedDeps = Omit<ImpServiceDeps, 'admission'>;

// The imp service and the RAM governor need each other: the service asks the
// governor before every boot, the governor sleeps imps through the service.
export function createGovernedImps(deps: GovernedDeps): {
  readonly imps: Imps;
  readonly governor: RamGovernor;
} {
  const holder: { imps: Pick<ImpRuntime, 'isImpBusy' | 'tracker' | 'trySleepImp'> | null } = {
    imps: null,
  };

  const readRamMib = deps.readRamMib ?? readOwnedRamMib;
  const log = deps.log ?? printLog;

  const governor = createRamGovernor({
    budgetMib: deps.config.ramBudgetMib,
    listAwake: async () => {
      const imps = await listImps(deps.db);

      return imps.flatMap((imp) =>
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
    isBusy: (id) =>
      holder.imps !== null && (holder.imps.isImpBusy(id) || holder.imps.tracker.count(id) > 0),
    trySleepImp: (id, reason) =>
      holder.imps === null
        ? Promise.resolve('skipped')
        : holder.imps.trySleepImp(id, reason, { by: 'governor' }),
    log,
  });

  const imps = createImpService({ ...deps, readRamMib, admission: governor });

  holder.imps = imps;

  return { imps, governor };
}
