import { openExecStream } from '../agent-client/exec-stream';
import type { AgentExecRequest, ExecStream } from '../agent-client/exec-stream';
import { findImpByName, listImps, updateImpActivity } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { readErrorMessage } from '../read-error-message';
import type { ActivityTracker } from './activity-tracker';
import type { ImpContext } from './imp-context';
import type { ImpLock, LockedImp } from './imp-lock';
import type { ImpVmOps } from './imp-vm-ops';
import { createLockFreeSleep } from './lock-free-sleep';
import type { LockFreeSleep, SleepOutcome, SleepPolicy } from './lock-free-sleep';
import type { ShutdownGate } from './shutdown-gate';

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

  // for the idle loop and the governor: sleeps the imp if it still runs and
  // `policy` still allows it
  readonly trySleepImp: LockFreeSleep;

  // on SIGTERM: every running imp to sleep, a few at a time. A wake or boot
  // already under way finishes first and is put to sleep; later ones fail.
  readonly sleepAllImps: () => Promise<void>;

  // after an impd start: re-adopt live VMs, mark the rest stopped; sleeping
  // imps stay asleep until something needs them
  readonly reconcileImps: () => Promise<void>;
  readonly isImpBusy: (id: string) => boolean;
  readonly tracker: ActivityTracker;
}

interface ImpRuntimeParts {
  readonly context: ImpContext;
  readonly gate: ShutdownGate;
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

  const isSleepAllowed = (imp: ImpRecord, policy: SleepPolicy): boolean => {
    if (context.tracker.count(imp.id) > 0) {
      return false;
    }

    if (imp.holdUntil !== null && imp.holdUntil.getTime() > Date.now()) {
      return false;
    }

    return policy.by === 'governor' || imp.lastActiveAt.getTime() <= policy.seenActiveAt;
  };

  // the caller holds the lock; a failure leaves the imp as sleepImpVm left it
  const sleepIfRunning = async (
    imp: LockedImp | undefined,
    reason: string,
  ): Promise<SleepOutcome> => {
    if (imp?.state !== 'running') {
      return 'skipped';
    }

    try {
      await ops.sleepImpVm(imp, reason);

      return 'slept';
    } catch (error) {
      context.log(`impd: ${imp.name}: could not sleep: ${readErrorMessage(error)}`);

      return 'failed';
    }
  };

  return {
    // a sleeping imp wakes and a stopped one boots, as for an HTTP request
    // The session counts from the moment the imp is found, before any wake,
    // so no background sleep slips in between the wake and the exec.
    openExec: async (name, request) => {
      const opened = { release: () => {} };

      try {
        const running = await requireRunning(name, (found) => {
          opened.release = context.tracker.open(found.id, 'exec');
        });

        const imp = running.imp;

        await updateImpActivity(context.db, imp.id, new Date());

        const stream = await openExecStream(context.findPaths(imp.id).vsockSocket, request);

        return {
          ...stream,
          close: () => {
            opened.release();
            stream.close();
          },
        };
      } catch (error) {
        opened.release();
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

    trySleepImp: createLockFreeSleep<LockedImp | undefined>(
      lock.tryWithImpId,
      (imp, reason, policy) =>
        imp !== undefined && isSleepAllowed(imp, policy)
          ? sleepIfRunning(imp, reason)
          : Promise.resolve<SleepOutcome>('skipped'),
    ),

    // open connections do not count: impd is going away
    sleepAllImps: async () => {
      parts.gate.close();

      // every imp, not only the running ones: a sleeping or stopped imp may be
      // waking or booting under its lock right now
      const imps = await listImps(context.db);

      await Promise.all(
        imps.map((imp) =>
          lock.withImpId(imp.id, (fresh) => sleepIfRunning(fresh, 'impd is stopping')),
        ),
      );
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
