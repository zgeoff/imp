import { buildAgentOutdatedError, hasFeature } from '../agent-client/agent-outdated';
import type { AgentFeature } from '../agent-client/agent-outdated';
import { sendActivity } from '../agent-client/agent-requests';
import type { AgentActivity } from '../agent-client/agent-requests';
import { openDialStream } from '../agent-client/dial-stream';
import type { DialStream, DialTarget } from '../agent-client/dial-stream';
import { openAttachStream, openExecStream } from '../agent-client/exec-stream';
import type { AgentAttachRequest, AgentExecRequest, ExecStream } from '../agent-client/exec-stream';
import { findImpByName, listImps, updateImpActivity } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { mergeEnv } from '../exec/merge-env';
import { readErrorMessage } from '../read-error-message';
import { readVmIdentity } from '../sleep/vm-identity';
import type { ImpPaths } from '../storage/data-layout';
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
  // long console session never blocks stop or destroy. `feature` fails the
  // exec with AGENT_OUTDATED when the imp's agent is older than it.
  readonly openExec: (
    name: string,
    request: AgentExecRequest,
    feature?: AgentFeature,
  ) => Promise<ExecStream>;

  // as openExec, for a session that exists
  readonly openAttach: (name: string, request: AgentAttachRequest) => Promise<ExecStream>;

  // as openExec, for a connection to an address inside the guest
  readonly openDial: (name: string, target: DialTarget) => Promise<DialStream>;
  readonly recordActivity: (name: string) => Promise<void>;

  // for the idle loop: the agent's activity, its sessions recorded on the
  // way; null when the agent does not answer
  readonly readActivity: (imp: ImpRecord) => Promise<AgentActivity | null>;

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

  // on SIGHUP: impd restarts in place and leaves VMs running, but a wake or
  // boot under way must finish, or its Firecracker has no record
  readonly waitForLifecycle: () => Promise<void>;

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

  // A sleeping imp wakes and a stopped one boots, as for an HTTP request.
  // The stream counts from the moment the imp is found, before any wake, so
  // no background sleep slips in between the wake and the open.
  const openStream = async <T extends { readonly close: () => void }>(
    name: string,
    open: (paths: ImpPaths, imp: ImpRecord) => Promise<T>,
  ): Promise<T> => {
    const opened = { release: () => {} };

    try {
      const running = await requireRunning(name, (found) => {
        opened.release = context.tracker.open(found.id, 'exec');
      });

      const imp = running.imp;

      await updateImpActivity(context.db, imp.id, new Date());

      const stream = await open(context.findPaths(imp.id), imp);

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
  };

  const isSleepAllowed = (imp: ImpRecord, policy: SleepPolicy): boolean => {
    if (context.tracker.count(imp.id) > 0) {
      return false;
    }

    if (imp.holdUntil !== null && imp.holdUntil.getTime() > context.now()) {
      return false;
    }

    return policy.by === 'governor' || imp.lastActiveAt.getTime() <= policy.seenActiveAt;
  };

  // the caller holds the lock; a failure leaves the imp as sleepImpVm left it.
  // `isWanted` lets a sleep that waits for a young guest give way.
  const sleepIfRunning = async (
    imp: LockedImp | undefined,
    reason: string,
    isWanted?: () => boolean,
  ): Promise<SleepOutcome> => {
    if (imp?.state !== 'running') {
      return 'skipped';
    }

    try {
      const after = await ops.sleepImpVm(imp, reason, isWanted);

      return after.state === 'sleeping' ? 'slept' : 'skipped';
    } catch (error) {
      context.log(`impd: ${imp.name}: could not sleep: ${readErrorMessage(error)}`);

      return 'failed';
    }
  };

  return {
    openExec: (name, request, feature) =>
      openStream(name, async (paths, imp) => {
        // an old agent would run a session's command as a plain exec
        if (request.session !== undefined) {
          requireFeature(paths, 'sessions');
        }

        if (feature !== undefined) {
          requireFeature(paths, feature);
        }

        const base = await context.readExecEnv(imp, paths.vsockSocket);

        const env = mergeEnv(base, request.env ?? []);

        return openExecStream(paths.vsockSocket, {
          ...request,
          ...(env.length > 0 && { env }),
        });
      }),
    openAttach: (name, request) =>
      openStream(name, (paths) => openAttachStream(paths.vsockSocket, request)),
    openDial: (name, target) =>
      openStream(name, (paths) => {
        requireFeature(paths, 'ssh');

        return openDialStream(paths.vsockSocket, target);
      }),

    readActivity: async (imp) => {
      try {
        const activity = await sendActivity(context.findPaths(imp.id).vsockSocket);

        context.sessions.record(imp.id, activity.sessions);

        return activity;
      } catch {
        return null;
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
          ? sleepIfRunning(imp, reason, () => isSleepAllowed(imp, policy))
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

            const error = 'impd stopped while the imp was being created';

            try {
              if (imp.pid !== null && context.vms.isVmAlive(imp.pid, paths)) {
                await context.vms.stopVm(imp.pid, paths, false);
              }
            } catch (stopError) {
              // one stuck VM must not keep impd from starting; the record
              // keeps its pid, so a start or destroy kills it again
              context.log(`impd: ${imp.name}: could not stop: ${readErrorMessage(stopError)}`);

              await ops.updateState(imp, { state: 'error', error });

              return;
            }

            await ops.updateState(imp, { state: 'error', pid: null, error });
          }),
        ),
      );
    },

    waitForLifecycle: () => lock.waitForAll(),
    isImpBusy: (id) => lock.isLocked(id),
    tracker: context.tracker,
  };
}

// fails before an old agent gets a request it cannot serve; an imp booted
// before impd recorded agent versions has none, and its answer decides
function requireFeature(paths: ImpPaths, feature: AgentFeature): void {
  const agentVersion = readVmIdentity(paths)?.agentVersion;

  if (agentVersion !== undefined && !hasFeature(agentVersion, feature)) {
    throw buildAgentOutdatedError(feature);
  }
}
