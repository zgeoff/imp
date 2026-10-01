import { mkdirSync, rmSync, statSync } from 'node:fs';
import type { Imp } from '@imp/api';
import { openExecStream } from '../agent-client/exec-stream';
import type { AgentExecRequest, ExecStream } from '../agent-client/exec-stream';
import { buildConflictError, buildNotFoundError, isRamBudgetError } from '../api-errors';
import type { Config } from '../config';
import type { ImageRecord } from '../db/images';
import { findImageById, listImages } from '../db/images';
import {
  allocateSlot,
  createImp,
  findImpById,
  findImpByName,
  listImps,
  removeImp,
  updateImpActivity,
  updateImpHold,
  updateImpState,
  updateImpStateIf,
} from '../db/imps';
import type { ImpRecord, ImpStateChange } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { RamAdmission } from '../governor/ram-governor';
import type { ImageService } from '../images/image-service';
import { countSlots, deriveSlotAddress } from '../net/addressing';
import type { TapDevices } from '../net/tap-devices';
import {
  checkSnapshotMatch,
  hasSnapshot,
  readSnapshotIdentity,
  readSnapshotMeta,
  removeSnapshot,
  writeSnapshotMeta,
} from '../sleep/snapshot-meta';
import type { SnapshotIdentity } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import { createReflinkClone } from '../storage/reflink';
import type { VmRunner } from '../vmm/vm-runner';
import { readVmRam } from '../vmm/vm-stats';
import { createActivityTracker } from './activity-tracker';
import type { ActivityTracker } from './activity-tracker';
import { requireTransition } from './imp-transitions';
import { createKeyedMutex } from './keyed-mutex';
import { createSemaphore } from './semaphore';

interface CreateImpInput {
  readonly name?: string | undefined;
  readonly image?: string | undefined;
  readonly vcpus?: number | undefined;
  readonly memoryMib?: number | undefined;
  readonly httpPort?: number | undefined;

  // fills the new imp's disk; a reflink clone of the image rootfs by default
  readonly prepareDisk?: (target: string) => Promise<void>;
}

interface ImpUrls {
  readonly local: string;
  readonly tailnet: string | null;
}

export interface ImpService {
  readonly createImp: (input: CreateImpInput) => Promise<Imp>;
  readonly listImps: () => Promise<Imp[]>;
  readonly getImp: (name: string) => Promise<Imp>;
  readonly startImp: (name: string) => Promise<Imp>;
  readonly stopImp: (name: string) => Promise<Imp>;
  readonly destroyImp: (name: string) => Promise<void>;
  readonly readUrls: (name: string) => Promise<ImpUrls>;

  // the imp must be running; exec runs outside the lifecycle lock, so a
  // long console session never blocks stop or destroy
  readonly openExec: (name: string, request: AgentExecRequest) => Promise<ExecStream>;
  readonly recordActivity: (name: string) => Promise<void>;

  // after an impd start: re-adopt live VMs, mark the rest stopped; sleeping
  // imps stay asleep until something needs them
  readonly reconcileImps: () => Promise<void>;

  // snapshot memory to disk and stop Firecracker (DESIGN 2.8)
  readonly sleepImp: (name: string) => Promise<Imp>;

  // a sleeping imp resumes from its snapshot, a stopped one boots cold
  readonly wakeImp: (name: string) => Promise<Imp>;

  // keeps the imp awake until now + seconds; 0 releases; wakes it if needed
  readonly holdImp: (name: string, seconds: number) => Promise<Imp>;

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
  readonly isImpBusy: (id: string) => boolean;
  readonly tracker: ActivityTracker;

  // Hooks for checkpoints/checkpoint-service.ts. `lockImp` runs `action` under
  // the imp's lifecycle lock with a fresh record; `haltImp` and `bootImp`
  // expect the caller to hold that lock.
  readonly lockImp: <T>(name: string, action: (imp: ImpRecord) => Promise<T>) => Promise<T>;
  readonly haltImp: (imp: ImpRecord) => Promise<ImpRecord>;
  readonly bootImp: (imp: ImpRecord) => Promise<ImpRecord>;

  // wakes a sleeping imp or boots a stopped one; the caller holds the lock
  readonly requireRunningImp: (imp: ImpRecord) => Promise<ImpRecord>;
  readonly toApi: (imp: ImpRecord) => Promise<Imp>;
}

export interface ImpServiceDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly images: ImageService;
  readonly taps: TapDevices;
  readonly vms: VmRunner;
  readonly log?: (message: string) => void;

  // a reflink clone by default; tests on a non-XFS tmpdir copy instead
  readonly cloneDisk?: (source: string, target: string) => Promise<void>;

  // the RAM governor; without one every boot is admitted
  readonly admission?: RamAdmission;

  // what a snapshot is tied to; read from the system files when left out
  readonly identity?: SnapshotIdentity;
  readonly readRamMib?: (pid: number, apiSocket: string) => number | null;

  // after a create or a destroy: the proxy opens or closes the imp's port
  readonly onImpsChanged?: () => void;
}

const NAME_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

// snapshot writes put the whole mem file through the page cache
// (docs/sleep-findings.md gotcha 8): a few at a time
const SLEEP_CONCURRENCY = 2;

export function createImpService(deps: ImpServiceDeps): ImpService {
  const mutex = createKeyedMutex();

  const log =
    deps.log ??
    ((message: string) => {
      console.log(message);
    });

  const cloneDisk = deps.cloneDisk ?? createReflinkClone;
  const slotPlan = { subnet: deps.config.subnet, portBase: deps.config.portBase };
  const tracker = createActivityTracker();
  const sleepSlots = createSemaphore(SLEEP_CONCURRENCY);

  const readRamMib =
    deps.readRamMib ?? ((pid, apiSocket) => readVmRam(pid, apiSocket)?.ownedMib ?? null);

  const identityCache: { value: SnapshotIdentity | null } = { value: deps.identity ?? null };

  const readIdentity = (): SnapshotIdentity => {
    identityCache.value ??= readSnapshotIdentity(deps.config);

    return identityCache.value;
  };

  const emitChanged = (): void => {
    deps.onImpsChanged?.();
  };

  const toApiImp = (imp: ImpRecord, imageName: string): Imp => {
    const api: Imp = {
      id: imp.id,
      name: imp.name,
      image: imageName,
      state: imp.state,
      vcpus: imp.vcpus,
      memoryMib: imp.memoryMib,
      ip: imp.ip,
      slot: imp.slot,
      port: deriveSlotAddress(imp.slot, slotPlan).tailnetPort,
      httpPort: imp.httpPort,
      url: buildLocalUrl(imp.name, deps.config.proxyPort),
      createdAt: imp.createdAt,
      lastActiveAt: imp.lastActiveAt,
    };

    if (imp.sleptAt !== null) {
      api.sleptAt = imp.sleptAt;
    }

    if (imp.holdUntil !== null) {
      api.holdUntil = imp.holdUntil;
    }

    if (imp.error !== null) {
      api.error = imp.error;
    }

    const ramMib =
      imp.state === 'running' && imp.pid !== null
        ? readRamMib(imp.pid, buildImpPaths(deps.config.dataDir, imp.id).apiSocket)
        : null;

    if (ramMib !== null) {
      api.ramMib = ramMib;
    }

    return api;
  };

  const readImageName = async (imageId: string): Promise<string> => {
    const image = await findImageById(deps.db, imageId);

    return image?.name ?? 'unknown';
  };

  const updateState = async (imp: ImpRecord, change: ImpStateChange): Promise<ImpRecord> => {
    if (change.state !== imp.state) {
      requireTransition(imp.state, change.state, `move to ${change.state}`);
    }

    const updated = await updateImpState(deps.db, imp.id, change);

    return updated;
  };

  // A dead VM or a lost snapshot means stopped. The repair is a compare-and-set
  // and skips a locked imp, so it never hides a VM that a start just booted.
  const checkLiveness = async (imp: ImpRecord): Promise<ImpRecord> => {
    const paths = buildImpPaths(deps.config.dataDir, imp.id);
    const lostSnapshot = imp.state === 'sleeping' && !hasSnapshot(paths);

    const lostVm =
      imp.state === 'running' && (imp.pid === null || !deps.vms.isVmAlive(imp.pid, paths));

    if ((!lostSnapshot && !lostVm) || mutex.isLocked(imp.id)) {
      return imp;
    }

    const repaired = await updateImpStateIf(
      deps.db,
      imp.id,
      { state: imp.state, pid: imp.pid },
      { state: 'stopped', pid: null },
    );

    if (repaired === undefined) {
      const current = await findImpById(deps.db, imp.id);

      return current ?? imp;
    }

    const what = lostSnapshot ? 'the snapshot is gone' : 'firecracker is gone';

    log(`impd: ${imp.name}: ${what}; marked it stopped`);

    return repaired;
  };

  const findOrThrow = async (name: string): Promise<ImpRecord> => {
    const imp = await findImpByName(deps.db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return checkLiveness(imp);
  };

  // the full text goes to the log, its first line to the record
  const writeFailure = async (imp: ImpRecord, error: unknown): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);

    log(`impd: ${imp.name}: ${message}`);

    await updateState(imp, { state: 'error', pid: null, error: message.split('\n')[0] ?? '' });
  };

  // boots the imp's disk; the caller holds the imp's lock
  const startImpVm = async (imp: ImpRecord): Promise<ImpRecord> => {
    const paths = buildImpPaths(deps.config.dataDir, imp.id);
    const address = deriveSlotAddress(imp.slot, slotPlan);

    // a memory snapshot is only valid with the disk it was taken with
    removeSnapshot(paths);

    // a fresh guest's RSS starts small and grows; reserve part of its memory
    await deps.admission?.admit({
      id: imp.id,
      name: imp.name,
      reserveMib: Math.ceil((imp.memoryMib * deps.config.bootReservePercent) / 100),
      memoryMib: imp.memoryMib,
    });

    try {
      await deps.taps.setupTap(address);

      const vm = await deps.vms.startVm({
        firecrackerBin: deps.config.firecrackerBin,
        kernelPath: deps.config.kernelPath,
        systemDrivePath: deps.config.systemDrivePath,
        paths,
        address,
        impId: imp.id,
        hostname: imp.name,
        vcpus: imp.vcpus,
        memoryMib: imp.memoryMib,
        dns: deps.config.dns,
      });

      log(`impd: ${imp.name}: booted pid ${String(vm.pid)} ${formatTimings(vm.timings)}`);

      await updateImpActivity(deps.db, imp.id, new Date());

      return await updateState(imp, {
        state: 'running',
        pid: vm.pid,
        error: null,
        sleptAt: null,
        firecrackerVersion: vm.firecrackerVersion,
      });
    } catch (error) {
      deps.admission?.release(imp.id);

      await writeFailure(imp, error);

      throw error;
    }
  };

  const createImpRecord = async (
    input: CreateImpInput,
    name: string,
    image: ImageRecord,
  ): Promise<ImpRecord> => {
    try {
      return await deps.db.transaction().execute(async (trx) => {
        const slot = await allocateSlot(trx, countSlots(deps.config.subnet));

        return createImp(trx, {
          name,
          imageId: image.id,
          vcpus: input.vcpus ?? deps.config.defaultVcpus,
          memoryMib: input.memoryMib ?? deps.config.defaultMemoryMib,
          ...(input.httpPort !== undefined && { httpPort: input.httpPort }),
          slot,
          ip: deriveSlotAddress(slot, slotPlan).guestIp,
        });
      });
    } catch (error) {
      // slot and ip come from the same transaction: only the name can clash
      if (isUniqueViolation(error)) {
        throw buildConflictError('imp', name);
      }

      throw error;
    }
  };

  // the requested name, else a free `imp-xxxx`
  const resolveImpName = async (requested: string | undefined): Promise<string> => {
    if (requested !== undefined) {
      return requested;
    }

    for (;;) {
      const picks = Array.from({ length: 4 }, () => Math.random() * NAME_ALPHABET.length);
      const suffix = picks.map((pick) => NAME_ALPHABET[Math.floor(pick)]).join('');
      const name = `imp-${suffix}`;

      const taken = await findImpByName(deps.db, name);

      if (taken === undefined) {
        return name;
      }
    }
  };

  // snapshots the VM and stops it; the caller holds the imp's lock. A failed
  // snapshot leaves the VM running; a failure after the kill stops the imp.
  const sleepImpVm = async (imp: ImpRecord, reason: string): Promise<ImpRecord> => {
    requireTransition(imp.state, 'sleeping', 'sleep');

    const paths = buildImpPaths(deps.config.dataDir, imp.id);
    const pid = imp.pid;

    if (pid === null) {
      throw new Error(`${imp.name} is running without a firecracker pid`);
    }

    const ramMib = readRamMib(pid, paths.apiSocket) ?? 0;
    const started = performance.now();

    try {
      const timings = await sleepSlots.run(() => deps.vms.sleepVm(pid, paths));

      writeSnapshotMeta(paths, {
        ...readIdentity(),
        createdAt: Date.now(),
        memoryMib: imp.memoryMib,
        ramMib,
      });

      const sleepMs = Math.round(performance.now() - started);

      log(
        `impd: ${imp.name}: asleep in ${String(sleepMs)}ms (${reason}), ram ${String(ramMib)} MiB, mem file ${String(readDiskMib(paths.memFile))} MiB on disk, ${formatTimings(timings)}`,
      );
    } catch (error) {
      if (deps.vms.isVmAlive(pid, paths)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);

      log(`impd: ${imp.name}: sleep failed after firecracker stopped: ${message}`);
      removeSnapshot(paths);
      deps.admission?.release(imp.id);

      await updateState(imp, { state: 'stopped', pid: null });

      throw error;
    }

    deps.admission?.release(imp.id);

    return updateState(imp, { state: 'sleeping', pid: null, sleptAt: new Date() });
  };

  // resumes from the snapshot, or boots cold when there is none, it does not
  // match this host, or the load fails: the disk is always the truth
  const wakeImpVm = async (imp: ImpRecord): Promise<ImpRecord> => {
    const paths = buildImpPaths(deps.config.dataDir, imp.id);
    const meta = readSnapshotMeta(paths);
    const mismatch = meta === null ? 'no snapshot' : checkSnapshotMatch(meta, readIdentity());

    if (meta === null || mismatch !== null) {
      log(`impd: ${imp.name}: cold boot instead of a wake: ${mismatch ?? 'no snapshot'}`);

      return startImpVm(imp);
    }

    // a woken VM faults its pages back in; it grows toward what it owned
    await deps.admission?.admit({
      id: imp.id,
      name: imp.name,
      reserveMib: Math.max(meta.ramMib, deps.config.wakeReserveMib),
      memoryMib: imp.memoryMib,
    });

    const started = performance.now();

    try {
      // a container restart takes the taps with it
      await deps.taps.setupTap(deriveSlotAddress(imp.slot, slotPlan));

      const vm = await deps.vms.wakeVm({ firecrackerBin: deps.config.firecrackerBin, paths });

      const wakeMs = Math.round(performance.now() - started);

      log(
        `impd: ${imp.name}: woke pid ${String(vm.pid)} in ${String(wakeMs)}ms ${formatTimings(vm.timings)}`,
      );

      await updateImpActivity(deps.db, imp.id, new Date());

      return await updateState(imp, {
        state: 'running',
        pid: vm.pid,
        error: null,
        sleptAt: null,
        firecrackerVersion: vm.firecrackerVersion,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      log(`impd: ${imp.name}: ${message.split('\n')[0] ?? ''}; booting cold`);
      deps.admission?.release(imp.id);

      return startImpVm(imp);
    }
  };

  // the running imp, woken or booted first; the caller holds the imp's lock
  const requireRunningLocked = async (imp: ImpRecord): Promise<ImpRecord> => {
    if (imp.state === 'running') {
      return imp;
    }

    if (imp.state === 'sleeping') {
      return wakeImpVm(imp);
    }

    requireTransition(imp.state, 'running', 'start');

    if (imp.pid !== null) {
      await deps.vms.stopVm(imp.pid, buildImpPaths(deps.config.dataDir, imp.id), false);
    }

    return startImpVm(imp);
  };

  const requireRunning = async (
    name: string,
    onFound?: (imp: ImpRecord) => void,
  ): Promise<{ readonly imp: ImpRecord; readonly wokeMs: number | null }> => {
    const found = await findOrThrow(name);

    onFound?.(found);

    // the hot path: no lock while nothing else changes the imp
    if (found.state === 'running' && !mutex.isLocked(found.id)) {
      return { imp: found, wokeMs: null };
    }

    const started = performance.now();

    return mutex.runExclusive(found.id, async () => {
      const imp = await findOrThrow(name);

      if (imp.state === 'running') {
        return { imp, wokeMs: null };
      }

      const running = await requireRunningLocked(imp);

      return { imp: running, wokeMs: Math.round(performance.now() - started) };
    });
  };

  const sleepImpById = (id: string, reason: string, onlyIdle: boolean): Promise<boolean> =>
    mutex.runExclusive(id, async () => {
      const imp = await findImpById(deps.db, id);

      if (imp?.state !== 'running' || (onlyIdle && tracker.count(id) > 0)) {
        return false;
      }

      try {
        await sleepImpVm(imp, reason);

        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        log(`impd: ${imp.name}: could not sleep: ${message}`);

        return false;
      }
    });

  // agent shutdown, then the memory goes too: a stopped imp boots cold; the
  // caller holds the imp's lock
  const stopImpVm = async (imp: ImpRecord): Promise<ImpRecord> => {
    const paths = buildImpPaths(deps.config.dataDir, imp.id);

    if (imp.pid !== null) {
      await deps.vms.stopVm(imp.pid, paths, true);
    }

    removeSnapshot(paths);
    deps.admission?.release(imp.id);

    return imp.state === 'stopped' ? imp : updateState(imp, { state: 'stopped', pid: null });
  };

  const toApiImpWithImage = async (imp: ImpRecord): Promise<Imp> => {
    const imageName = await readImageName(imp.imageId);

    return toApiImp(imp, imageName);
  };

  return {
    createImp: async (input) => {
      const name = await resolveImpName(input.name);
      const image = await deps.images.resolveImage(input.image);
      const created = await createImpRecord(input, name, image);

      emitChanged();

      return mutex.runExclusive(created.id, async () => {
        const paths = buildImpPaths(deps.config.dataDir, created.id);
        const started = performance.now();

        try {
          mkdirSync(paths.runDir, { recursive: true });

          await (
            input.prepareDisk ?? ((disk) => cloneDisk(deps.images.getRootfsPath(image), disk))
          )(paths.disk);
        } catch (error) {
          await writeFailure(created, error);

          throw error;
        }

        const cloneMs = Math.round(performance.now() - started);

        log(`impd: ${name}: disk cloned in ${String(cloneMs)}ms`);

        try {
          const running = await startImpVm(created);

          return toApiImp(running, image.name);
        } catch (error) {
          // the governor turned the boot away before any tap or VM existed: a
          // create that cannot run leaves no imp behind
          if (isRamBudgetError(error)) {
            rmSync(paths.dir, { recursive: true, force: true });

            await removeImp(deps.db, created.id);

            emitChanged();
          }

          throw error;
        }
      });
    },

    listImps: async () => {
      const [imps, images] = await Promise.all([listImps(deps.db), listImages(deps.db)]);

      const names = new Map(images.map((image) => [image.id, image.name]));

      const fresh = await Promise.all(imps.map((imp) => checkLiveness(imp)));

      return fresh.map((imp) => toApiImp(imp, names.get(imp.imageId) ?? 'unknown'));
    },

    getImp: async (name) => {
      const imp = await findOrThrow(name);
      const imageName = await readImageName(imp.imageId);

      return toApiImp(imp, imageName);
    },

    startImp: async (name) => {
      const found = await findOrThrow(name);

      return mutex.runExclusive(found.id, async () => {
        const imp = await findOrThrow(name);
        const running = await requireRunningLocked(imp);

        return toApiImpWithImage(running);
      });
    },

    stopImp: async (name) => {
      const found = await findOrThrow(name);

      return mutex.runExclusive(found.id, async () => {
        const imp = await findOrThrow(name);

        if (imp.state === 'stopped') {
          const imageName = await readImageName(imp.imageId);

          return toApiImp(imp, imageName);
        }

        requireTransition(imp.state, 'stopped', 'stop');

        const stopped = await stopImpVm(imp);
        const imageName = await readImageName(stopped.imageId);

        return toApiImp(stopped, imageName);
      });
    },

    destroyImp: async (name) => {
      const found = await findOrThrow(name);

      await mutex.runExclusive(found.id, async () => {
        const imp = await findOrThrow(name);

        const paths = buildImpPaths(deps.config.dataDir, imp.id);

        if (imp.pid !== null) {
          await deps.vms.stopVm(imp.pid, paths, false);
        }

        await deps.taps.removeTap(deriveSlotAddress(imp.slot, slotPlan).tap);

        rmSync(paths.dir, { recursive: true, force: true });
        deps.admission?.release(imp.id);

        await removeImp(deps.db, imp.id);
      });

      emitChanged();
    },

    readUrls: async (name) => {
      const imp = await findOrThrow(name);

      const port = deriveSlotAddress(imp.slot, slotPlan).tailnetPort;

      return {
        local: buildLocalUrl(imp.name, deps.config.proxyPort),
        tailnet:
          deps.config.tailscaleAuthKey === null
            ? null
            : `http://${deps.config.tailscaleHostname}:${String(port)}`,
      };
    },

    // a sleeping imp wakes and a stopped one boots, as for an HTTP request
    openExec: async (name, request) => {
      const running = await requireRunning(name);

      const imp = running.imp;

      await updateImpActivity(deps.db, imp.id, new Date());

      const release = tracker.open(imp.id, 'exec');

      try {
        const stream = await openExecStream(
          buildImpPaths(deps.config.dataDir, imp.id).vsockSocket,
          request,
        );

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
      const imp = await findImpByName(deps.db, name);

      if (imp !== undefined) {
        await updateImpActivity(deps.db, imp.id, new Date());
      }
    },

    reconcileImps: async () => {
      const imps = await listImps(deps.db);

      await Promise.all(
        imps.map(async (imp) => {
          if (imp.state !== 'running' && imp.state !== 'creating') {
            return;
          }

          const paths = buildImpPaths(deps.config.dataDir, imp.id);
          const alive = imp.pid !== null && deps.vms.isVmAlive(imp.pid, paths);

          // a loaded guest may answer late; killing it would lose its memory
          if (imp.state === 'running' && alive) {
            const ready = await deps.vms.isAgentReady(paths);

            const note = ready ? '' : ' (the agent does not answer yet)';

            log(`impd: ${imp.name}: re-adopted firecracker pid ${String(imp.pid)}${note}`);

            return;
          }

          if (alive && imp.pid !== null) {
            await deps.vms.stopVm(imp.pid, paths, false);
          }

          if (imp.state === 'creating') {
            await updateState(imp, {
              state: 'error',
              pid: null,
              error: 'impd stopped while the imp was being created',
            });

            return;
          }

          log(`impd: ${imp.name}: no live VM after restart; marking it stopped`);

          await updateState(imp, { state: 'stopped', pid: null });
        }),
      );
    },

    sleepImp: async (name) => {
      const found = await findOrThrow(name);

      return mutex.runExclusive(found.id, async () => {
        const imp = await findOrThrow(name);

        const asleep = imp.state === 'sleeping' ? imp : await sleepImpVm(imp, 'requested');

        return toApiImpWithImage(asleep);
      });
    },

    wakeImp: async (name) => {
      const found = await findOrThrow(name);

      return mutex.runExclusive(found.id, async () => {
        const imp = await findOrThrow(name);
        const running = await requireRunningLocked(imp);

        return toApiImpWithImage(running);
      });
    },

    holdImp: async (name, seconds) => {
      const found = await findOrThrow(name);

      return mutex.runExclusive(found.id, async () => {
        const imp = await findOrThrow(name);

        const until = seconds > 0 ? new Date(Date.now() + seconds * 1000) : null;

        const held = await updateImpHold(deps.db, imp.id, until);

        if (until === null) {
          return toApiImpWithImage(held);
        }

        await updateImpActivity(deps.db, imp.id, new Date());

        const running = await requireRunningLocked(held);

        return toApiImpWithImage(running);
      });
    },

    requireRunning,
    sleepImpById,

    sleepAllImps: async () => {
      const imps = await listImps(deps.db);

      const running = imps.filter((imp) => imp.state === 'running');

      await Promise.all(running.map((imp) => sleepImpById(imp.id, 'impd is stopping', false)));
    },

    isImpBusy: (id) => mutex.isLocked(id),
    tracker,
    lockImp: async (name, action) => {
      const found = await findOrThrow(name);

      return mutex.runExclusive(found.id, async () => {
        const imp = await findOrThrow(name);

        return action(imp);
      });
    },

    haltImp: stopImpVm,
    requireRunningImp: requireRunningLocked,

    bootImp: (imp) => startImpVm(imp),

    toApi: async (imp) => {
      const imageName = await readImageName(imp.imageId);

      return toApiImp(imp, imageName);
    },
  };
}

// allocated size: the mem file is sparse after --dig-holes
function readDiskMib(path: string): number {
  try {
    return Math.round((statSync(path).blocks * 512) / 1_048_576);
  } catch {
    return 0;
  }
}

function buildLocalUrl(name: string, proxyPort: number): string {
  return `http://${name}.imp.localhost:${String(proxyPort)}`;
}

function formatTimings(timings: Readonly<Record<string, number>>): string {
  return Object.entries(timings)
    .map(([step, ms]) => `${step}=${String(ms)}ms`)
    .join(' ');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}
