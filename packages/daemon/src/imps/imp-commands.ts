import { mkdirSync, rmSync } from 'node:fs';
import type { EgressPolicy, Imp } from '@imp/api';
import { buildInvalidStateError, isRamBudgetError } from '../api-errors';
import { listCheckpoints } from '../db/checkpoints';
import type { ImageRecord } from '../db/images';
import { listImps, removeImp, updateImpDisk, updateImpSettings, updateImpState } from '../db/imps';
import { readErrorMessage } from '../read-error-message';
import { buildImagePaths } from '../storage/data-layout';
import { resolveCpuSettings } from './cpu-limit';
import { createImpRecord } from './create-imp-record';
import type { ImpContext } from './imp-context';
import { MIB, buildDiskTooSmallError, growDiskFile, readFileBytes } from './imp-disk';
import type { ImpLeases } from './imp-leases';
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

  // the networks it joins, by id, in the insert's transaction
  readonly networkIds?: readonly string[] | undefined;

  // the disk's size: IMP_DEFAULT_DISK_GIB by default, the source's size for
  // a disk that prepareDisk makes
  readonly diskMib?: number | undefined;

  // creates the new imp's disk; a clone of the image rootfs by default
  readonly prepareDisk?: (impId: string) => Promise<void>;

  // false leaves the new imp stopped, as a restore from backup does
  readonly start?: boolean;

  // a fork of a template copy that has not booted yet owes the reset too
  readonly isIdentityResetPending?: boolean;

  // a move keeps the imp's id, and stages it marked `receiving`; a warm
  // move keeps its slot too, and a grow its guest still owes
  readonly id?: string;
  readonly moveState?: 'receiving';
  readonly slot?: number;
  readonly isDiskGrowPending?: boolean;
}

interface DestroyOptions {
  // the move's own destroy of an imp it marked
  readonly isMove?: boolean;
}

// The imp API's commands. Each takes the imp's lock for its whole run.
export interface ImpCommands {
  readonly createImp: (input: CreateImpInput) => Promise<Imp>;
  readonly listImps: () => Promise<Imp[]>;
  readonly getImp: (name: string) => Promise<Imp>;
  readonly startImp: (name: string) => Promise<Imp>;

  // `force` ends the imp's leases from leases.*, which fail it with LEASED
  // otherwise (docs/guides/leases.md#sleep-and-stop)
  readonly stopImp: (name: string, force?: boolean) => Promise<Imp>;
  readonly destroyImp: (name: string, options?: DestroyOptions) => Promise<void>;
  readonly readUrls: (name: string) => Promise<ImpUrls>;

  // snapshot memory to disk and stop Firecracker
  // (docs/architecture/sleep-and-wake.md#sleep); `force` as for stopImp
  readonly sleepImp: (name: string, force?: boolean) => Promise<Imp>;

  // a sleeping imp resumes from its snapshot, a stopped one boots cold; an
  // imp in error boots cold too, unless restartError is false
  readonly wakeImp: (name: string, restartError?: boolean) => Promise<Imp>;

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
  readonly leases: Pick<ImpLeases, 'requireUnleased' | 'endForcedLeases'>;
}

export function createImpCommands(parts: ImpCommandParts): ImpCommands {
  const context = parts.context;
  const lock = parts.lock;
  const ops = parts.ops;
  const presenter = parts.presenter;
  const leases = parts.leases;

  return {
    createImp: async (input) => {
      const received = performance.now();

      const image = await context.images.resolveImage(input.image);

      if (input.policy !== undefined) {
        context.egress.requirePolicy(input.policy);
      }

      const diskBytes = resolveDiskBytes(context, input, image);
      const id = input.id ?? Bun.randomUUIDv7();

      // a template's disk holds its source's machine-id and ssh host keys; a
      // fork keeps its source's, reset or not
      const isIdentityResetPending =
        input.isIdentityResetPending ?? (image.source === 'imp' && input.prepareDisk === undefined);

      const writeRecord = () =>
        createImpRecord(context, id, { ...input, diskBytes, isIdentityResetPending }, image);

      // a thin clone takes next to nothing, but none is made past the reserve
      await context.diskBudget.requireRoom(0);

      return lock.withNewImp(id, writeRecord, async (imp) => {
        const paths = context.findPaths(imp.id);
        const started = performance.now();
        const recordMs = Math.round(started - received);

        try {
          // the slot's firewall, fresh, before anything can bring its tap up
          await context.egress.addSlot(imp.slot);

          // a warm move's guest knows its gateway by the slot's MAC: a tap a
          // failed destroy left in the slot may have another, so it goes
          if (input.slot !== undefined) {
            await context.taps.removeTap(context.findAddress(imp.slot).tap);
          }

          mkdirSync(paths.runDir, { recursive: true });
        } catch (error) {
          await ops.writeFailure(imp, error);

          throw error;
        }

        const timing = { cloneMs: 0, sizeMs: 0 };

        const createDiskCopy = async () => {
          await (
            input.prepareDisk ??
            ((impId) =>
              context.storage.createImpDisk(impId, { kind: 'image', digest: image.digest }))
          )(imp.id);

          timing.cloneMs = Math.round(performance.now() - started);

          context.log(`impd: ${imp.name}: disk cloned in ${String(timing.cloneMs)}ms`);
        };

        // a fork or a restore takes its source's size, an image's disk grows
        // past the image's filesystem, and the filesystem with it
        const growNewDisk = async () => {
          const sizeStarted = performance.now();
          const cloneBytes = readFileBytes(paths.disk);
          const sizedBytes = growDiskFile(paths.disk, diskBytes ?? 0);

          if (sizedBytes > cloneBytes) {
            await growStoppedFilesystem(context, imp.name, paths.disk);
          }

          const sized = await updateImpDisk(context.db, imp.id, {
            diskBytes: sizedBytes,
            isGrowPending: input.isDiskGrowPending === true,
          });

          timing.sizeMs = Math.round(performance.now() - sizeStarted);

          return sized;
        };

        const setupNewDisk = async () => {
          await createDiskCopy();

          return growNewDisk();
        };

        // past the lifecycle table: no stop ever leaves `creating` otherwise
        if (input.start === false) {
          try {
            await setupNewDisk();
          } catch (error) {
            await ops.writeFailure(imp, error);

            throw error;
          }

          const stopped = await updateImpState(context.db, imp.id, {
            reason: 'stopped',
            state: 'stopped',
          });

          return presenter.toApi(stopped);
        }

        // the boot starts while the disk is cloned and sized: a template
        // restore only needs the disk once its guest is parked
        const sizing = setupNewDisk();

        // handled now: the boot may fail before it looks at the disk
        void Promise.allSettled([sizing]);

        try {
          const bootStarted = performance.now();

          const running = await ops.startNewImpVm(imp, sizing);

          const bootMs = Math.round(performance.now() - bootStarted);

          const presented = await presenter.toApi(running);

          const totalMs = Math.round(performance.now() - received);

          // the server's side of `imp new`; clone and size run inside boot,
          // and the boot's own steps are on its line
          context.log(
            `impd: ${imp.name}: created in ${String(totalMs)}ms record=${String(recordMs)}ms clone=${String(timing.cloneMs)}ms size=${String(timing.sizeMs)}ms boot=${String(bootMs)}ms`,
          );

          return presented;
        } catch (error) {
          // a resize still at work keeps its files until it ends
          await Promise.allSettled([sizing]);

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

    // a call that changes nothing answers as it always did, leased or not;
    // a forced one ends the leases only once the imp has stopped
    stopImp: (name, force = false) =>
      lock.withImp(name, async (imp) => {
        if (imp.state === 'stopped') {
          return presenter.toApi(imp);
        }

        requireTransition(imp.state, 'stopped', 'stop');

        await leases.requireUnleased(imp, force);

        const stopped = await ops.stopImpVm(imp);

        const after =
          force && stopped.state === 'stopped' ? await leases.endForcedLeases(stopped) : stopped;

        return presenter.toApi(after);
      }),

    destroyImp: async (name, options = {}) => {
      await lock.withImp(
        name,
        async (imp) => {
          const paths = context.findPaths(imp.id);

          if (imp.pid !== null) {
            await context.vms.stopVm(imp.pid, paths, false);
          }

          // the VM is gone: an empty cgroup and its jail can go; a jail mount
          // would keep a ZFS disk busy
          await context.cgroups.remove(imp.id);
          await context.vms.removeJail(paths);
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
        },
        options,
      );
    },

    readUrls: async (name) => {
      const imp = await lock.findImp(name);

      return presenter.readUrls(imp);
    },

    // as for stop
    sleepImp: (name, force = false) =>
      lock.withImp(name, async (imp) => {
        if (imp.state === 'sleeping') {
          return presenter.toApi(imp);
        }

        requireTransition(imp.state, 'sleeping', 'sleep');

        await leases.requireUnleased(imp, force);

        const asleep = await ops.sleepImpVm(imp, 'requested');

        const after =
          force && asleep.state === 'sleeping' ? await leases.endForcedLeases(asleep) : asleep;

        return presenter.toApi(after);
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

// The size a new disk gets. A size below the image's filesystem (a
// template's disk) is refused; the default grows to it. A prepareDisk disk
// keeps its source's size unless a larger one is asked for.
function resolveDiskBytes(
  context: ImpContext,
  input: CreateImpInput,
  image: ImageRecord,
): number | undefined {
  const requested = input.diskMib === undefined ? undefined : input.diskMib * MIB;

  if (input.prepareDisk !== undefined) {
    return requested;
  }

  const floor = readFileBytes(buildImagePaths(context.config.dataDir, image.digest).rootfs);

  if (requested !== undefined && requested < floor) {
    const what =
      image.source === 'imp' ? `template ${image.name}'s disk` : "the image's filesystem";

    throw buildDiskTooSmallError(requested, floor, what);
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
