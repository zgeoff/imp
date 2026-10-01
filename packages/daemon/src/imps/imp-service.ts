import { mkdirSync, rmSync } from 'node:fs';
import type { Imp } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { openExecStream } from '../agent-client/exec-stream';
import type { AgentExecRequest, ExecStream } from '../agent-client/exec-stream';
import { buildConflictError, buildInvalidStateError, buildNotFoundError } from '../api-errors';
import type { Config } from '../config';
import type { ImageRecord } from '../db/images';
import { findImageById, listImages } from '../db/images';
import {
  allocateSlot,
  createImp,
  findImpByName,
  listImps,
  removeImp,
  updateImpActivity,
  updateImpState,
} from '../db/imps';
import type { ImpRecord, ImpStateChange } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { ImageService } from '../images/image-service';
import { countSlots, deriveSlotAddress } from '../net/addressing';
import type { TapDevices } from '../net/tap-devices';
import { buildImpPaths } from '../storage/data-layout';
import { createReflinkClone } from '../storage/reflink';
import type { VmRunner } from '../vmm/vm-runner';
import { requireTransition } from './imp-transitions';
import { createKeyedMutex } from './keyed-mutex';

interface CreateImpInput {
  readonly name?: string | undefined;
  readonly image?: string | undefined;
  readonly vcpus?: number | undefined;
  readonly memoryMib?: number | undefined;
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

  // after an impd start: re-adopt live VMs, mark the rest stopped
  readonly reconcileImps: () => Promise<void>;
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
}

const NAME_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function createImpService(deps: ImpServiceDeps): ImpService {
  const mutex = createKeyedMutex();

  const log =
    deps.log ??
    ((message: string) => {
      console.log(message);
    });

  const cloneDisk = deps.cloneDisk ?? createReflinkClone;
  const slotPlan = { subnet: deps.config.subnet, portBase: deps.config.portBase };

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
      port: deps.config.portBase + imp.slot,
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

  // a running imp whose Firecracker died is stopped; seen on any read
  const checkLiveness = async (imp: ImpRecord): Promise<ImpRecord> => {
    const paths = buildImpPaths(deps.config.dataDir, imp.id);

    if (imp.state !== 'running' || (imp.pid !== null && deps.vms.isVmAlive(imp.pid, paths))) {
      return imp;
    }

    log(`impd: ${imp.name}: firecracker is gone; marking it stopped`);

    const stopped = await updateState(imp, { state: 'stopped', pid: null });

    return stopped;
  };

  const findOrThrow = async (name: string): Promise<ImpRecord> => {
    const imp = await findImpByName(deps.db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return checkLiveness(imp);
  };

  // boots the imp's disk; the caller holds the imp's lock
  const startImpVm = async (imp: ImpRecord): Promise<ImpRecord> => {
    const paths = buildImpPaths(deps.config.dataDir, imp.id);
    const address = deriveSlotAddress(imp.slot, slotPlan);

    try {
      await deps.taps.setupTap(address);

      const vm = await deps.vms.startVm({
        firecrackerBin: deps.config.firecrackerBin,
        kernelPath: deps.config.kernelPath,
        systemDrivePath: deps.config.systemDrivePath,
        paths,
        address,
        hostname: imp.name,
        vcpus: imp.vcpus,
        memoryMib: imp.memoryMib,
        dns: deps.config.dns,
      });

      log(`impd: ${imp.name}: booted pid ${String(vm.pid)} ${formatTimings(vm.timings)}`);

      return await updateState(imp, {
        state: 'running',
        pid: vm.pid,
        error: null,
        firecrackerVersion: vm.firecrackerVersion,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      log(`impd: ${imp.name}: ${message}`);

      await updateState(imp, { state: 'error', pid: null, error: message.split('\n')[0] ?? '' });

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
          slot,
          ip: deriveSlotAddress(slot, slotPlan).guestIp,
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('imps.name')) {
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

  return {
    createImp: async (input) => {
      const name = await resolveImpName(input.name);
      const existing = await findImpByName(deps.db, name);

      if (existing !== undefined) {
        throw buildConflictError('imp', name);
      }

      const image = await deps.images.resolveImage(input.image);
      const created = await createImpRecord(input, name, image);

      return mutex.runExclusive(created.id, async () => {
        const paths = buildImpPaths(deps.config.dataDir, created.id);
        const started = performance.now();

        try {
          mkdirSync(paths.runDir, { recursive: true });

          await cloneDisk(deps.images.getRootfsPath(image), paths.disk);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          await updateState(created, { state: 'error', error: message });

          throw error;
        }

        const cloneMs = Math.round(performance.now() - started);

        log(`impd: ${name}: disk cloned in ${String(cloneMs)}ms`);

        const running = await startImpVm(created);

        return toApiImp(running, image.name);
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

        if (imp.state === 'sleeping') {
          throw new ORPCError('NOT_IMPLEMENTED', { message: 'wake is not implemented yet' });
        }

        if (imp.state !== 'running') {
          requireTransition(imp.state, 'running', 'start');

          const paths = buildImpPaths(deps.config.dataDir, imp.id);

          if (imp.pid !== null) {
            await deps.vms.stopVm(imp.pid, paths, false);
          }

          const running = await startImpVm(imp);
          const imageName = await readImageName(running.imageId);

          return toApiImp(running, imageName);
        }

        const imageName = await readImageName(imp.imageId);

        return toApiImp(imp, imageName);
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

        if (imp.pid !== null) {
          await deps.vms.stopVm(imp.pid, buildImpPaths(deps.config.dataDir, imp.id), true);
        }

        const stopped = await updateState(imp, { state: 'stopped', pid: null });
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

        await removeImp(deps.db, imp.id);
      });
    },

    readUrls: async (name) => {
      const imp = await findOrThrow(name);

      const port = deps.config.portBase + imp.slot;

      return {
        local: buildLocalUrl(imp.name, deps.config.proxyPort),
        tailnet: deps.config.tailscaleAuthKey === null ? null : `http://imp:${String(port)}`,
      };
    },

    openExec: async (name, request) => {
      const imp = await findOrThrow(name);

      if (imp.state !== 'running') {
        throw buildInvalidStateError(imp.state, ['running'], 'exec in');
      }

      await updateImpActivity(deps.db, imp.id, new Date());

      return openExecStream(buildImpPaths(deps.config.dataDir, imp.id).vsockSocket, request);
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
          const ready = alive ? await deps.vms.isAgentReady(paths) : false;

          if (imp.state === 'running' && ready) {
            log(`impd: ${imp.name}: re-adopted firecracker pid ${String(imp.pid)}`);

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
  };
}

function buildLocalUrl(name: string, proxyPort: number): string {
  return `http://${name}.imp.localhost:${String(proxyPort)}`;
}

function formatTimings(timings: Readonly<Record<string, number>>): string {
  return Object.entries(timings)
    .map(([step, ms]) => `${step}=${String(ms)}ms`)
    .join(' ');
}
