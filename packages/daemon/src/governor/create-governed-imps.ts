import { listImps } from '../db/imps';
import { createImpService } from '../imps/imp-service';
import type { ImpService, ImpServiceDeps } from '../imps/imp-service';
import { buildImpPaths } from '../storage/data-layout';
import { readVmRam } from '../vmm/vm-stats';
import { createRamGovernor } from './ram-governor';
import type { RamGovernor } from './ram-governor';

type GovernedDeps = Omit<ImpServiceDeps, 'admission'>;

// The imp service and the RAM governor need each other: the service asks the
// governor before every boot, the governor sleeps imps through the service.
export function createGovernedImps(deps: GovernedDeps): {
  readonly imps: ImpService;
  readonly governor: RamGovernor;
} {
  const holder: { imps: ImpService | null } = { imps: null };

  const readRamMib =
    deps.readRamMib ?? ((pid, apiSocket) => readVmRam(pid, apiSocket)?.ownedMib ?? null);

  const log =
    deps.log ??
    ((message: string) => {
      console.log(message);
    });

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
    sleepImp: (id, reason) =>
      holder.imps === null ? Promise.resolve(false) : holder.imps.sleepImpById(id, reason, true),
    log,
  });

  const imps = createImpService({ ...deps, readRamMib, admission: governor });

  holder.imps = imps;

  return { imps, governor };
}
