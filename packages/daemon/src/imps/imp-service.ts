import type { Imp } from '@imp/api';
import type { ImpRecord } from '../db/imps';
import { countSessions } from '../sessions/count-sessions';
import { createSessionService } from '../sessions/session-service';
import type { SessionService } from '../sessions/session-service';
import { readBootStatus } from './boot-status';
import type { BootStatus } from './boot-status';
import type { ImpCommands } from './imp-commands';
import { createImpCommands } from './imp-commands';
import { createImpContext } from './imp-context';
import type { ImpServiceDeps } from './imp-context';
import { createImpLock } from './imp-lock';
import type { LockedImp } from './imp-lock';
import { createImpPresenter } from './imp-presenter';
import { createImpRuntime } from './imp-runtime';
import type { ImpRuntime } from './imp-runtime';
import { createImpVmOps } from './imp-vm-ops';
import { createShutdownGate } from './shutdown-gate';

export type { ImpServiceDeps } from './imp-context';

// The imp API: what the router and the exec and tunnel endpoints call.
export type ImpService = ImpCommands &
  SessionService &
  Pick<ImpRuntime, 'openExec' | 'openAttach' | 'openDial' | 'recordActivity'> & {
    // sessions impd last saw in the imp; undefined when it has not seen any
    readonly countSessions: (imp: ImpRecord) => number | undefined;
    readonly readBootStatus: (imp: ImpRecord) => BootStatus;
  };

// For checkpoints/checkpoint-service.ts. `lockImp` runs `action` under the
// imp's lifecycle lock with a fresh record; the other hooks take that record.
export interface ImpCheckpointHooks {
  readonly createImp: ImpCommands['createImp'];
  readonly lockImp: <T>(name: string, action: (imp: LockedImp) => Promise<T>) => Promise<T>;
  readonly haltImp: (imp: LockedImp) => Promise<LockedImp>;
  readonly bootImp: (imp: LockedImp) => Promise<LockedImp>;

  // wakes a sleeping imp or boots a stopped one
  readonly requireRunningImp: (imp: LockedImp) => Promise<LockedImp>;
  readonly toApi: (imp: ImpRecord) => Promise<Imp>;
}

// Every face of the service: impd's main wires each part to the one it needs.
export type Imps = ImpService & ImpRuntime & ImpCheckpointHooks;

export function createImpService(deps: ImpServiceDeps): Imps {
  const context = createImpContext(deps);
  const lock = createImpLock(context);
  const gate = createShutdownGate();
  const ops = createImpVmOps(context, gate);
  const presenter = createImpPresenter(context);
  const commands = createImpCommands({ context, lock, ops, presenter });
  const runtime = createImpRuntime({ context, gate, lock, ops });

  const sessions = createSessionService({
    context,
    lock,
    requireRunning: runtime.requireRunning,
  });

  return {
    ...commands,
    ...runtime,
    ...sessions,
    countSessions: (imp) => countSessions(context, imp),
    readBootStatus: (imp) => readBootStatus(imp, context.findPaths(imp.id), context.identity),
    lockImp: lock.withImp,
    haltImp: ops.stopImpVm,
    bootImp: ops.startImpVm,
    requireRunningImp: ops.requireRunningImp,
    toApi: presenter.toApi,
  };
}
