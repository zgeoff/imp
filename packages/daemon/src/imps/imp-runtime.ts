import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import {
  buildAgentOutdatedError,
  buildAgentUnknownError,
  hasFeature,
} from '../agent-client/agent-outdated';
import type { AgentFeature } from '../agent-client/agent-outdated';
import { sendActivity, sendPing } from '../agent-client/agent-requests';
import type { AgentActivity } from '../agent-client/agent-requests';
import { openDialStream } from '../agent-client/dial-stream';
import type { DialStream, DialTarget } from '../agent-client/dial-stream';
import { openAttachStream, openExecStream } from '../agent-client/exec-stream';
import type { AgentAttachRequest, AgentExecRequest, ExecStream } from '../agent-client/exec-stream';
import { openAccept, openListener } from '../agent-client/listener-stream';
import type { GuestListener, ListenSpec } from '../agent-client/listener-stream';
import { buildInvalidStateError, isDiskFullError } from '../api-errors';
import { listColdBoots, writeUnknownBoot } from '../db/cold-boots';
import { findImpById, findImpByName, listImps, updateImpActivity } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { buildBrokerNotReadyError, checkBrokerReady, isBrokerRequired } from '../exec/exec-require';
import { mergeEnv } from '../exec/merge-env';
import { readErrorMessage } from '../read-error-message';
import { toSeenSessions } from '../sessions/session-cache';
import { readVmIdentity } from '../sleep/vm-identity';
import type { ImpPaths } from '../storage/data-layout';
import type { BootTemplates } from '../templates/boot-templates';
import { isJailedFirecracker } from '../vmm/firecracker-process';
import type { ActivityTracker, ConnectionKind } from './activity-tracker';
import { checkAdoptedMergeFlag } from './check-merge-flag';
import type { ImpContext } from './imp-context';
import type { ImpLock, LockedImp } from './imp-lock';
import type { ImpVmOps, YoungGuestWait } from './imp-vm-ops';
import { createLockFreeSleep } from './lock-free-sleep';
import type { LockFreeSleep, SleepOutcome, SleepPolicy } from './lock-free-sleep';
import { startCounting } from './read-running-imp-usage';
import { createVmReconciler } from './reconcile-vms';
import type { ShutdownGate } from './shutdown-gate';

// What the wake proxy, the idle loop, the governor and impd's start and stop
// need: imps woken on demand, put to sleep in the background, and the
// connections that keep them awake.
export interface ImpRuntime {
  // the imp must be running; exec runs outside the lifecycle lock (one that
  // requires the broker holds it only until the start), so a console never
  // blocks stop. `feature`: AGENT_OUTDATED when the agent is older than it.
  readonly openExec: (
    name: string,
    request: AgentExecRequest,
    feature?: AgentFeature,
  ) => Promise<ExecStream>;

  // as openExec, for a session that exists; with `wake: false`, an imp that
  // is not running fails with INVALID_STATE and nothing boots
  readonly openAttach: (name: string, request: AgentAttachRequest) => Promise<ExecStream>;

  // as openExec, for a connection to an address inside the guest; `kind` is
  // what it counts as while open: an SSH forward or an `imp proxy` tunnel
  readonly openDial: (
    name: string,
    target: DialTarget,
    kind: Extract<ConnectionKind, 'ssh' | 'tunnel'>,
  ) => Promise<DialStream>;

  // as openExec, for ssh-agent forwarding and reverse forwards: a socket in
  // the guest, and the relay for each client. A null `kind` counts for
  // nothing: a reverse forward alone does not keep the imp awake.
  readonly openListener: (
    name: string,
    spec: ListenSpec,
    kind: Extract<ConnectionKind, 'ssh'> | null,
  ) => Promise<GuestListener>;
  readonly openAccept: (
    name: string,
    listener: string,
    connection: number,
    kind: Extract<ConnectionKind, 'ssh' | 'tunnel'>,
  ) => Promise<DialStream>;
  readonly recordActivity: (name: string) => Promise<void>;

  // as openExec, for any other agent connection: `open` gets the vsock
  // socket once the imp runs, and the connection counts as an exec until
  // its `close`; `feature` as for openExec
  readonly openAgentStream: <T extends { readonly close: () => void }>(
    name: string,
    open: (vsockPath: string) => Promise<T>,
    feature?: AgentFeature,
  ) => Promise<T>;

  // for a watcher that must not wake the imp or keep it awake: the imp as
  // it is, and its agent's vsock socket when it runs; `feature` as for
  // openExec, checked only then
  readonly findAgent: (
    name: string,
    feature?: AgentFeature,
  ) => Promise<{ readonly imp: ImpRecord; readonly vsockPath: string | null }>;

  // as openAgentStream, for one request: it counts as an exec until `send`
  // settles
  readonly sendToAgent: <T>(
    name: string,
    send: (vsockPath: string) => Promise<T>,
    feature?: AgentFeature,
  ) => Promise<T>;

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

  // for the memory controller: runs `action` under the imp's lock when the
  // lock is free and the imp still runs; false when it did not run
  readonly tryWhileRunning: (id: string, action: () => Promise<void>) => Promise<boolean>;
  readonly tracker: ActivityTracker;

  // the boot templates cold boots restore; null when IMP_BOOT_TEMPLATES is off
  readonly bootTemplates: BootTemplates | null;

  // the DISK_FULL that last turned a background sleep away
  readonly readDiskFullError: () => Error | null;
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
  const reconciler = createVmReconciler(context, ops);
  const lastDiskFull: { error: Error | null } = { error: null };

  // An elastic guest may hold more than its memory, and a new impd's cgroup
  // writer knows nothing of it: the limit covers what the guest holds, or the
  // most it can, before a sleep or a snapshot sets up the cgroup again.
  const setAdoptedMemoryLimit = async (imp: LockedImp, paths: ImpPaths): Promise<void> => {
    if (imp.maxMemoryMib <= imp.memoryMib) {
      return;
    }

    const pluggedMib = await context.vms.readGuestMemory(paths).then(
      (memory) => Math.max(memory.pluggedMib, memory.requestedMib),
      () => imp.maxMemoryMib - imp.memoryMib,
    );

    context.memoryLimit.setGuestMib(imp.id, imp.memoryMib + pluggedMib);
  };

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

  // as requireRunning, for a caller that must not boot or wake the imp: one
  // that is not running fails with INVALID_STATE and its cold boots
  const requireAwake: ImpRuntime['requireRunning'] = async (name, onFound) => {
    const found = await lock.findImp(name);

    if (found.state === 'running' && !lock.isLocked(found.id)) {
      onFound?.(found);

      return { imp: found, wokeMs: null };
    }

    return lock.withImp(name, async (imp) => {
      if (imp.state !== 'running') {
        throw await buildNotAwakeError(context, imp);
      }

      onFound?.(imp);

      return { imp, wokeMs: null };
    });
  };

  // A sleeping imp wakes and a stopped one boots, as for an HTTP request.
  // The stream counts from the moment the imp is found, before any wake, so
  // no background sleep slips in between the wake and the open.
  const openStream = async <T extends { readonly close: () => void }>(
    name: string,
    kind: ConnectionKind | null,
    open: (paths: ImpPaths, imp: ImpRecord) => Promise<T>,
    wake = true,
  ): Promise<T> => {
    const opened = { release: () => {} };

    try {
      const findRunning = wake ? requireRunning : requireAwake;

      const running = await findRunning(name, (found) => {
        if (kind !== null) {
          opened.release = context.tracker.open(found.id, kind);
        }
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

  // The governor sleeps at once: it holds admission, and the boot waiting on
  // it matters more than a slow wake later. Other sleeps wait for a young
  // guest, and give way if the imp turns busy or is held meanwhile.
  const buildYoungGuestWait = (id: string, policy: SleepPolicy): YoungGuestWait => {
    if (policy.by === 'governor') {
      return { wait: false };
    }

    const isWanted = async (): Promise<boolean> => {
      const fresh = await findImpById(context.db, id);

      return fresh !== undefined && isSleepAllowed(fresh, policy);
    };

    return { wait: true, isWanted };
  };

  // the caller holds the lock; a failure leaves the imp as sleepImpVm left it
  const sleepIfRunning = async (
    imp: LockedImp | undefined,
    reason: string,
    youngGuest?: YoungGuestWait,
  ): Promise<SleepOutcome> => {
    if (imp?.state !== 'running') {
      return 'skipped';
    }

    try {
      const after = await ops.sleepImpVm(imp, reason, youngGuest);

      return after.state === 'sleeping' ? 'slept' : 'skipped';
    } catch (error) {
      // the disk budget logs a low disk once for the whole disk
      if (isDiskFullError(error)) {
        lastDiskFull.error = error;

        return 'diskFull';
      }

      context.log(`impd: ${imp.name}: could not sleep: ${readErrorMessage(error)}`);

      return 'failed';
    }
  };

  return {
    openExec: (name, request, feature) =>
      openStream(name, 'exec', (paths, imp) => {
        const requiresBroker = isBrokerRequired(request.require);

        // the egress broker's variables are for the imp's own code, not the
        // agent's world
        if (requiresBroker && request.outer === true) {
          throw buildBrokerNotReadyError('an exec in the agent gets no broker variables');
        }

        // an old agent would run a session's command as a plain exec
        if (request.session !== undefined) {
          requireFeature(paths, 'sessions');
        }

        if (feature !== undefined) {
          requireFeature(paths, feature);
        }

        if (request.outer === true) {
          requireFeature(paths, 'outer-exec');

          return openExecStream(paths.vsockSocket, request);
        }

        // the broker's variables under the caller's own; a command that
        // requires the broker starts only with them as impd set them
        const startWithBroker = async (target: ImpRecord): Promise<ExecStream> => {
          const broker = await context.readExecEnv(target, paths.vsockSocket);

          const base = broker.kind === 'ready' ? broker.env : [];
          const env = mergeEnv(base, request.env ?? []);

          if (requiresBroker) {
            const refused = checkBrokerReady(broker, env);

            if (refused !== null) {
              throw refused;
            }

            await requireSameBoot(context, target);
          }

          const opening = openExecStream(paths.vsockSocket, {
            ...request,
            ...(env.length > 0 && { env }),
          });

          return request.session === undefined ? opening : withColdBoots(context, target, opening);
        };

        if (!requiresBroker) {
          return startWithBroker(imp);
        }

        // Under the lock no restore, reboot or sleep replaces the guest
        // between the bundle step and the start; an imp a stop got to first
        // boots again, as for any exec. It may wait behind a locked operation.
        return lock.withImp(name, async (locked) => {
          const running = locked.state === 'running' ? locked : await ops.requireRunningImp(locked);

          return startWithBroker(running);
        });
      }),
    openAttach: (name, request) =>
      openStream(
        name,
        'exec',
        (paths, imp) => withColdBoots(context, imp, openAttachStream(paths.vsockSocket, request)),
        request.wake ?? true,
      ),
    openDial: (name, target, kind) =>
      openStream(name, kind, (paths) => {
        // an older agent dials a unix socket as root, past its mode
        const feature = target.network === 'unix' ? 'unix-dial-as-user' : 'ssh';

        requireFeature(paths, feature);

        return openDialStream(paths.vsockSocket, target);
      }),
    openListener: (name, spec, kind) =>
      openStream(name, kind, (paths) => {
        const feature = spec.network === 'ssh-agent' ? 'agent-forwarding' : 'reverse-forward';

        requireFeature(paths, feature);

        return openListener(paths.vsockSocket, spec);
      }),
    openAccept: (name, listener, connection, kind) =>
      openStream(name, kind, (paths) => openAccept(paths.vsockSocket, listener, connection)),

    readActivity: async (imp) => {
      try {
        const activity = await sendActivity(context.findPaths(imp.id).vsockSocket);

        context.sessions.record(imp.id, toSeenSessions(activity.sessions, new Date()));

        return activity;
      } catch {
        return null;
      }
    },

    openAgentStream: (name, open, feature) =>
      openStream(name, 'exec', (paths) => {
        if (feature !== undefined) {
          requireFeature(paths, feature);
        }

        return open(paths.vsockSocket);
      }),

    findAgent: async (name, feature) => {
      const imp = await lock.findImp(name);

      if (imp.state !== 'running' || lock.isLocked(imp.id)) {
        return { imp, vsockPath: null };
      }

      const paths = context.findPaths(imp.id);

      if (feature !== undefined) {
        requireFeature(paths, feature);
      }

      return { imp, vsockPath: paths.vsockSocket };
    },

    sendToAgent: async (name, send, feature) => {
      const sent = await openStream(name, 'exec', async (paths) => {
        if (feature !== undefined) {
          requireFeature(paths, feature);
        }

        const value = await send(paths.vsockSocket);

        return { value, close: () => {} };
      });

      sent.close();

      return sent.value;
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
          ? sleepIfRunning(imp, reason, buildYoungGuestWait(imp.id, policy))
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

      // cgroups of imps destroyed while impd was down, or whose remove failed
      const impIds = new Set(imps.map((imp) => imp.id));

      // the jails first: their sweep kills every process of the uid, a
      // template build's too, so the cgroups are empty for the rmdir
      for (const impId of await context.vms.removeOrphanJails(impIds)) {
        context.log(`impd: removed the jail of imp ${impId}: no imp has that id`);
      }

      for (const impId of context.cgroups.removeOrphans(impIds)) {
        context.log(`impd: removed the cgroup of imp ${impId}: no imp has that id`);
      }

      await Promise.all(
        imps.map((listed) =>
          lock.withImpId(listed.id, async (found) => {
            if (found === undefined) {
              return;
            }

            const imp = await reconciler.reconcileImp(found);

            const paths = context.findPaths(imp.id);

            // a loaded guest may answer late; killing it would lose its memory
            if (imp.state === 'running') {
              const ready = await context.vms.isAgentReady(paths);

              const note = ready ? '' : ' (the agent does not answer yet)';
              const jailed = imp.pid !== null && isJailedFirecracker(imp.pid) ? 'jailed ' : '';

              context.log(
                `impd: ${imp.name}: re-adopted ${jailed}firecracker pid ${String(imp.pid)}${note}`,
              );

              if (imp.pid !== null) {
                await setAdoptedMemoryLimit(imp, paths);

                context.cgroups.adopt(imp.id, imp.pid, imp.cpu, imp.memoryMib);

                startCounting(context, imp, imp.pid);

                await checkAdoptedMergeFlag(context, imp, imp.pid);
              }

              if (ready) {
                await writeAdoptedBoot(context, imp);
              }

              // the record does not change; the event stream still hears of it
              await ops.updateState(imp, { reason: 'adopted', state: 'running' });

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

              await ops.updateState(imp, { reason: 'failed', state: 'error', error });

              return;
            }

            await ops.updateState(imp, { reason: 'failed', state: 'error', pid: null, error });
          }),
        ),
      );

      await reconciler.killUnknownVms(new Set(imps.map((imp) => imp.id)));
    },

    waitForLifecycle: () => lock.waitForAll(),
    isImpBusy: (id) => lock.isLocked(id),

    tryWhileRunning: async (id, action) => {
      const result = await lock.tryWithImpId(id, async (imp) => {
        if (imp?.state !== 'running') {
          return false;
        }

        await action();

        return true;
      });

      return result.ran && result.value;
    },

    tracker: context.tracker,
    bootTemplates: context.templates,
    readDiskFullError: () => lastDiskFull.error,
  };
}

// The guest the bundle step ran in is the one the command starts in: the
// caller holds the lock, and this catches any write that got past it.
async function requireSameBoot(context: ImpContext, imp: ImpRecord): Promise<void> {
  const fresh = await findImpById(context.db, imp.id);

  if (fresh?.state !== 'running' || fresh.pid !== imp.pid) {
    throw buildBrokerNotReadyError('the imp booted again after the broker CA step');
  }
}

// A session's output, and NO_SESSION, name the imp's cold boots, read after
// any boot the open caused, so that boot comes first
async function withColdBoots(
  context: ImpContext,
  imp: ImpRecord,
  opening: Promise<ExecStream>,
): Promise<ExecStream> {
  let stream: ExecStream;

  try {
    stream = await opening;
  } catch (error) {
    if (error instanceof AgentError && error.code === 'NO_SESSION' && isRecord(error.data)) {
      const coldBoots = await listColdBoots(context.db, imp.id);

      throw new AgentError(error.code, error.detail, { ...error.data, coldBoots });
    }

    throw error;
  }

  const output = stream.output;

  if (output?.continuity !== 'offsets') {
    return stream;
  }

  const coldBoots = await listColdBoots(context.db, imp.id).catch((error: unknown) => {
    stream.close();
    throw error;
  });

  return { ...stream, output: { ...output, coldBoots } };
}

// INVALID_STATE for an attach that must not wake the imp; an imp still
// being created has no boots to name
async function buildNotAwakeError(context: ImpContext, imp: ImpRecord): Promise<Error> {
  const error = buildInvalidStateError(imp.state, ['running'], 'attach without a wake to');

  if (imp.state === 'creating') {
    return error;
  }

  const coldBoots = await listColdBoots(context.db, imp.id);

  return new ORPCError('INVALID_STATE', {
    status: error.status,
    message: error.message,
    data: { ...error.data, coldBoots },
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

// A VM booted before impd kept cold boots has none on record: its boot is
// `unknown`, so a client still learns that it ended earlier generations.
async function writeAdoptedBoot(context: ImpContext, imp: ImpRecord): Promise<void> {
  try {
    const ping = await sendPing(context.findPaths(imp.id).vsockSocket);

    if (ping.boot_id !== undefined) {
      await writeUnknownBoot(context.db, imp.id, ping.boot_id, new Date());
    }
  } catch (error) {
    context.log(`impd: ${imp.name}: could not read its boot id: ${readErrorMessage(error)}`);
  }
}

// fails before an old agent gets a request it cannot serve; an imp booted
// before impd recorded agent versions has none, and its answer decides
// unless the feature is strict
function requireFeature(paths: ImpPaths, feature: AgentFeature): void {
  const agentVersion = readVmIdentity(paths)?.agentVersion;

  if (!hasFeature(agentVersion, feature)) {
    throw agentVersion === undefined
      ? buildAgentUnknownError(feature)
      : buildAgentOutdatedError(feature);
  }
}
