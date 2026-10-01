import { openExecStream } from '../agent-client/exec-stream';
import type { AgentExecRequest, ExecStream } from '../agent-client/exec-stream';
import { findImpByName, listImps, updateImpActivity } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { readErrorMessage } from '../read-error-message';
import type { ActivityTracker } from './activity-tracker';
import type { ImpContext } from './imp-context';
import type { ImpLock } from './imp-lock';
import type { ImpVmOps } from './imp-vm-ops';

// What the wake proxy, the idle loop, the governor and impd's start and stop
// need: imps woken on demand, put to sleep in the background, and the
// connections that keep them awake.
export interface ImpRuntime {
  // the imp must be running; exec runs outside the lifecycle lock, so a
  // long console session never blocks stop or destroy
  readonly openExec: (name: string, request: AgentExecRequest) => Promise<ExecStream>;
  readonly recordActivity: (name: string) => Promise<void>;

  // for the wake proxy: the running imp, woken or booted first if needed;
  // `wokeMs` is null when it already ran. `onFound` runs before any wait, so
  // the caller can count its connection before the idle loop looks again.
  readonly requireRunning: (
    name: string,
    onFound?: (imp: ImpRecord) => void,
  ) => Promise<{ readonly imp: ImpRecord; readonly wokeMs: number | null }>;

  // for the idle loop and the governor: sleeps the imp if it still runs (and,
  // with `onlyIdle`, has no open connection); false when it did not sleep
  readonly sleepImpById: (id: string, reason: string, onlyIdle: boolean) => Promise<boolean>;

  // on SIGTERM: every running imp to sleep, a few at a time
  readonly sleepAllImps: () => Promise<void>;

  // after an impd start: re-adopt live VMs, mark the rest stopped; sleeping
  // imps stay asleep until something needs them
  readonly reconcileImps: () => Promise<void>;
  readonly isImpBusy: (id: string) => boolean;
  readonly tracker: ActivityTracker;
}

interface ImpRuntimeParts {
  readonly context: ImpContext;
  readonly lock: ImpLock;
  readonly ops: ImpVmOps;
}

export function createImpRuntime(parts: ImpRuntimeParts): ImpRuntime {
  const context = parts.context;
  const lock = parts.lock;
  const ops = parts.ops;

  const requireRunning: ImpRuntime['requireRunning'] = async (name, onFound) => {
    const found = await lock.findImp(name);

    onFound?.(found);

    // the hot path: no lock while nothing else changes the imp
    if (found.state === 'running' && !lock.isLocked(found.id)) {
      return { imp: found, wokeMs: null };
    }

    const started = performance.now();

    return lock.withImp(name, async (imp) => {
      if (imp.state === 'running') {
        return { imp, wokeMs: null };
      }

      const running = await ops.requireRunningImp(imp);

      return { imp: running, wokeMs: Math.round(performance.now() - started) };
    });
  };

  const sleepImpById: ImpRuntime['sleepImpById'] = (id, reason, onlyIdle) =>
    lock.withImpId(id, async (imp) => {
      if (imp?.state !== 'running' || (onlyIdle && context.tracker.count(id) > 0)) {
        return false;
      }

      try {
        await ops.sleepImpVm(imp, reason);

        return true;
      } catch (error) {
        context.log(`impd: ${imp.name}: could not sleep: ${readErrorMessage(error)}`);

        return false;
      }
    });

  return {
    // a sleeping imp wakes and a stopped one boots, as for an HTTP request
    openExec: async (name, request) => {
      const running = await requireRunning(name);

      const imp = running.imp;

      await updateImpActivity(context.db, imp.id, new Date());

      const release = context.tracker.open(imp.id, 'exec');

      try {
        const stream = await openExecStream(context.findPaths(imp.id).vsockSocket, request);

        return {
          ...stream,
          close: () => {
            release();

            stream.close();
          },
        };
      } catch (error) {
        release();
        throw error;
      }
    },

    recordActivity: async (name) => {
      const imp = await findImpByName(context.db, name);

      if (imp !== undefined) {
        await updateImpActivity(context.db, imp.id, new Date());
      }
    },

    requireRunning,
    sleepImpById,

    sleepAllImps: async () => {
      const imps = await listImps(context.db);

      const running = imps.filter((imp) => imp.state === 'running');

      await Promise.all(running.map((imp) => sleepImpById(imp.id, 'impd is stopping', false)));
    },

    // the lock's liveness check marks an imp whose VM died with impd stopped
    reconcileImps: async () => {
      const imps = await listImps(context.db);

      await Promise.all(
        imps.map((listed) =>
          lock.withImpId(listed.id, async (imp) => {
            if (imp === undefined) {
              return;
            }

            const paths = context.findPaths(imp.id);

            // a loaded guest may answer late; killing it would lose its memory
            if (imp.state === 'running') {
              const ready = await context.vms.isAgentReady(paths);

              const note = ready ? '' : ' (the agent does not answer yet)';

              context.log(
                `impd: ${imp.name}: re-adopted firecracker pid ${String(imp.pid)}${note}`,
              );

              return;
            }

            if (imp.state !== 'creating') {
              return;
            }

            if (imp.pid !== null && context.vms.isVmAlive(imp.pid, paths)) {
              await context.vms.stopVm(imp.pid, paths, false);
            }

            await ops.updateState(imp, {
              state: 'error',
              pid: null,
              error: 'impd stopped while the imp was being created',
            });
          }),
        ),
      );
    },

    isImpBusy: (id) => lock.isLocked(id),
    tracker: context.tracker,
  };
}
