import { mkdirSync, rmSync } from 'node:fs';
import type { EgressPolicy, Imp } from '@imp/api';
import { buildInvalidStateError, isRamBudgetError } from '../api-errors';
import { listCheckpoints } from '../db/checkpoints';
import {
  listImps,
  removeImp,
  updateImpActivity,
  updateImpDisk,
  updateImpHold,
  updateImpSettings,
  updateImpState,
} from '../db/imps';
import { readErrorMessage } from '../read-error-message';
import { buildImagePaths } from '../storage/data-layout';
import { resolveCpuSettings } from './cpu-limit';
import { createImpRecord } from './create-imp-record';
import type { ImpContext } from './imp-context';
import { MIB, buildDiskTooSmallError, growDiskFile, readFileBytes } from './imp-disk';
import { checkLiveness } from './imp-liveness';
import { toLockedImp } from './imp-lock';
import type { ImpLock } from './imp-lock';
import type { ImpPresenter, ImpUrls } from './imp-presenter';
import { requireTransition } from './imp-transitions';
import type { ImpVmOps } from './imp-vm-ops';

interface CreateImpInput {
  readonly name?: string | undefined;
  readonly image?: string | undefined;
  readonly vcpus?: number | undefined;
  readonly memoryMib?: number | undefined;
  readonly httpPort?: number | undefined;
  readonly policy?: EgressPolicy | undefined;
  readonly cpuLimit?: number | null | undefined;
  readonly cpuWeight?: number | undefined;

  // the disk's size: IMP_DEFAULT_DISK_GIB by default, the source's size for
  // a disk that prepareDisk makes
  readonly diskMib?: number | undefined;

  // creates the new imp's disk; a clone of the image rootfs by default
  readonly prepareDisk?: (impId: string) => Promise<void>;

  // false leaves the new imp stopped, as a restore from backup does
  readonly start?: boolean;
}

// The imp API's commands. Each takes the imp's lock for its whole run.
export interface ImpCommands {
  readonly createImp: (input: CreateImpInput) => Promise<Imp>;
  readonly listImps: () => Promise<Imp[]>;
  readonly getImp: (name: string) => Promise<Imp>;
  readonly startImp: (name: string) => Promise<Imp>;
  readonly stopImp: (name: string) => Promise<Imp>;
  readonly destroyImp: (name: string) => Promise<void>;
  readonly readUrls: (name: string) => Promise<ImpUrls>;

  // snapshot memory to disk and stop Firecracker
  // (docs/architecture/sleep-and-wake.md#sleep)
  readonly sleepImp: (name: string) => Promise<Imp>;

  // a sleeping imp resumes from its snapshot, a stopped one boots cold; an
  // imp in error boots cold too, unless restartError is false
  readonly wakeImp: (name: string, restartError?: boolean) => Promise<Imp>;

  // keeps the imp awake until now + seconds; 0 releases; wakes it if needed
  readonly holdImp: (name: string, seconds: number) => Promise<Imp>;

  // grows the disk file; the guest grows its filesystem into it now when
  // running, at its next wake when sleeping, at its next boot when stopped
  readonly resizeDisk: (name: string, diskMib: number) => Promise<Imp>;

  // a running VM takes a new limit or weight at once, a sleeping or stopped
  // one when it next starts; the vCPU count only while stopped, since a
  // memory snapshot fixes it. The HTTP port holds from the next request.
  readonly updateImp: (name: string, change: ImpUpdate) => Promise<Imp>;
}

interface ImpUpdate {
  readonly cpuLimit?: number | null | undefined;
  readonly cpuWeight?: number | undefined;
  readonly vcpus?: number | undefined;
  readonly httpPort?: number | undefined;
}

interface ImpCommandParts {
  readonly context: ImpContext;
  readonly lock: ImpLock;
  readonly ops: ImpVmOps;
  readonly presenter: ImpPresenter;
}

export function createImpCommands(parts: ImpCommandParts): ImpCommands {
  const context = parts.context;
  const lock = parts.lock;
  const ops = parts.ops;
  const presenter = parts.presenter;

  return {
    createImp: async (input) => {
      const image = await context.images.resolveImage(input.image);

      if (input.policy !== undefined) {
        context.egress.requirePolicy(input.policy);
      }

      const diskBytes = resolveDiskBytes(context, input, image.digest);
      const id = Bun.randomUUIDv7();
      const writeRecord = () => createImpRecord(context, id, { ...input, diskBytes }, image);

      // a thin clone takes next to nothing, but none is made past the reserve
      await context.diskBudget.requireRoom(0);

      return lock.withNewImp(id, writeRecord, async (imp) => {
        const paths = context.findPaths(imp.id);
        const started = performance.now();

        try {
          // the slot's firewall, fresh, before anything can bring its tap up
          await context.egress.addSlot(imp.slot);

          mkdirSync(paths.runDir, { recursive: true });

          await (
            input.prepareDisk ??
            ((impId) =>
              context.storage.createImpDisk(impId, { kind: 'image', digest: image.digest }))
          )(imp.id);
        } catch (error) {
          await ops.writeFailure(imp, error);

          throw error;
        }

        const cloneMs = Math.round(performance.now() - started);

        context.log(`impd: ${imp.name}: disk cloned in ${String(cloneMs)}ms`);

        // a fork or a restore takes its source's size, an image's disk grows
        // past the image's filesystem, and the filesystem with it
        const cloneBytes = readFileBytes(paths.disk);
        const sizedBytes = growDiskFile(paths.disk, diskBytes ?? 0);

        if (sizedBytes > cloneBytes) {
          await growStoppedFilesystem(context, imp.name, paths.disk);
        }

        const sized = await updateImpDisk(context.db, imp.id, {
          diskBytes: sizedBytes,
          isGrowPending: false,
        });

        // past the lifecycle table: no stop ever leaves `creating` otherwise
        if (input.start === false) {
          const stopped = await updateImpState(context.db, imp.id, {
            reason: 'stopped',
            state: 'stopped',
          });

          return presenter.toApi(stopped);
        }

        try {
          const running = await ops.startImpVm(toLockedImp(imp, sized));

          return await presenter.toApi(running);
        } catch (error) {
          // the governor turned the boot away before any tap or VM existed: a
          // create that cannot run leaves no imp behind
          if (isRamBudgetError(error)) {
            await removeImpFiles(context, imp.id, []);
            await removeImp(context.db, imp.id);
          }

          throw error;
        }
      });
    },

    listImps: async () => {
      const imps = await listImps(context.db);

      const fresh = await Promise.all(
        imps.map((imp) => checkLiveness(context, imp, !lock.isLocked(imp.id))),
      );

      return presenter.toApiList(fresh);
    },

    getImp: async (name) => {
      const imp = await lock.findImp(name);

      return presenter.toApi(imp);
    },

    startImp: (name) =>
      lock.withImp(name, async (imp) => {
        const running = await ops.requireRunningImp(imp);

        return presenter.toApi(running);
      }),

    stopImp: (name) =>
      lock.withImp(name, async (imp) => {
        if (imp.state === 'stopped') {
          return presenter.toApi(imp);
        }

        requireTransition(imp.state, 'stopped', 'stop');

        const stopped = await ops.stopImpVm(imp);

        return presenter.toApi(stopped);
      }),

    destroyImp: async (name) => {
      await lock.withImp(name, async (imp) => {
        const paths = context.findPaths(imp.id);

        if (imp.pid !== null) {
          await context.vms.stopVm(imp.pid, paths, false);
        }

        // the VM is gone: an empty cgroup can go
        await context.cgroups.remove(imp.id);
        await context.taps.removeTap(context.findAddress(imp.slot).tap);

        // out of the firewall before another imp can take the slot
        await context.egress.releaseSlot(imp.slot);

        const checkpoints = await listCheckpoints(context.db, imp.id);

        await removeImpFiles(
          context,
          imp.id,
          checkpoints.map((checkpoint) => checkpoint.id),
        );

        context.admission?.release(imp.id);

        await removeImp(context.db, imp.id);
      });
    },

    readUrls: async (name) => {
      const imp = await lock.findImp(name);

      return presenter.readUrls(imp);
    },

    sleepImp: (name) =>
      lock.withImp(name, async (imp) => {
        const asleep = imp.state === 'sleeping' ? imp : await ops.sleepImpVm(imp, 'requested');

        return presenter.toApi(asleep);
      }),

    wakeImp: (name, restartError = true) =>
      lock.withImp(name, async (imp) => {
        if (imp.state === 'error' && !restartError) {
          throw buildInvalidStateError(imp.state, ['running', 'sleeping', 'stopped'], 'wake');
        }

        const running = await ops.requireRunningImp(imp);

        return presenter.toApi(running);
      }),

    resizeDisk: (name, diskMib) =>
      lock.withImp(name, async (imp) => {
        if (imp.state === 'creating') {
          throw buildInvalidStateError(
            imp.state,
            ['running', 'sleeping', 'stopped', 'error'],
            'resize',
          );
        }

        const diskBytes = diskMib * MIB;

        if (diskBytes < imp.diskBytes) {
          throw buildDiskTooSmallError(diskBytes, imp.diskBytes, 'the disk now; a disk only grows');
        }

        if (diskBytes === imp.diskBytes) {
          return presenter.toApi(imp);
        }

        const paths = context.findPaths(imp.id);

        // the file is sparse: room past the reserve is all it needs now
        await context.diskBudget.requireRoom(0);

        growDiskFile(paths.disk, diskBytes);

        // a stopped guest grows on its next boot, a sleeping one on its wake
        const updated = await updateImpDisk(context.db, imp.id, {
          diskBytes,
          isGrowPending: imp.state === 'sleeping',
        });

        const grown = toLockedImp(imp, updated);

        context.log(`impd: ${imp.name}: disk grown to ${String(diskMib)} MiB`);

        // no VM has the disk open: the host grows its filesystem now
        if (grown.pid === null && grown.state !== 'sleeping') {
          await growStoppedFilesystem(context, imp.name, paths.disk);
        }

        if (grown.state !== 'running') {
          return presenter.toApi(grown);
        }

        const resized = await ops.growGuestDisk(grown);

        return presenter.toApi(resized);
      }),

    holdImp: (name, seconds) =>
      lock.withImp(name, async (imp) => {
        const until = seconds > 0 ? new Date(context.now() + seconds * 1000) : null;

        const updated = await updateImpHold(context.db, imp.id, until);

        const held = toLockedImp(imp, updated);

        if (until === null) {
          return presenter.toApi(held);
        }

        await updateImpActivity(context.db, imp.id, new Date());

        const running = await ops.requireRunningImp(held);

        return presenter.toApi(running);
      }),

    updateImp: (name, change) =>
      lock.withImp(name, async (imp) => {
        const vcpus = change.vcpus ?? imp.vcpus;

        if (vcpus !== imp.vcpus && imp.state !== 'stopped') {
          throw buildInvalidStateError(imp.state, ['stopped'], 'change the vCPU count of');
        }

        const cpu = resolveCpuSettings(change, imp.cpu, context.hostCpus);

        const updated = await updateImpSettings(context.db, imp.id, {
          cpu,
          vcpus,
          httpPort: change.httpPort ?? imp.httpPort,
        });

        if (updated.state === 'running') {
          context.cgroups.apply(imp.id, cpu);
        }

        return presenter.toApi(toLockedImp(imp, updated));
      }),
  };
}

// The size a new disk gets. An explicit size below the image's filesystem
// is refused; the default grows to it. A disk prepareDisk makes keeps the
// size of its source unless a larger one is asked for.
function resolveDiskBytes(
  context: ImpContext,
  input: CreateImpInput,
  digest: string,
): number | undefined {
  const requested = input.diskMib === undefined ? undefined : input.diskMib * MIB;

  if (input.prepareDisk !== undefined) {
    return requested;
  }

  const floor = readFileBytes(buildImagePaths(context.config.dataDir, digest).rootfs);

  if (requested !== undefined && requested < floor) {
    throw buildDiskTooSmallError(requested, floor, "the image's filesystem");
  }

  return requested ?? Math.max(context.config.defaultDiskBytes, floor);
}

// The host's grow is the cheap one; when it fails or skips an unclean
// filesystem, the guest's next boot grows it instead.
async function growStoppedFilesystem(context: ImpContext, name: string, disk: string) {
  try {
    const isGrown = await context.growFilesystem(disk);

    if (!isGrown) {
      context.log(`impd: ${name}: the filesystem was not unmounted cleanly; its boot grows it`);
    }
  } catch (error) {
    context.log(
      `impd: ${name}: the host could not grow the filesystem: ${readErrorMessage(error)}`,
    );
  }
}

// The disk goes through the backend first: on ZFS a dataset is mounted inside
// the imp's directory, and rm -r fails on it.
async function removeImpFiles(
  context: ImpContext,
  impId: string,
  checkpointIds: readonly string[],
): Promise<void> {
  const paths = context.findPaths(impId);

  await context.storage.removeImpDisk(impId, checkpointIds);

  rmSync(paths.dir, { recursive: true, force: true });
  rmSync(paths.snapshotDir, { recursive: true, force: true });
}
