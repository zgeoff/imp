import { mkdirSync, rmSync } from 'node:fs';
import type { Imp } from '@imp/api';
import { buildNotFoundError, isRamBudgetError } from '../api-errors';
import { listImps, removeImp, updateImpActivity, updateImpHold } from '../db/imps';
import { createImpRecord } from './create-imp-record';
import type { ImpContext } from './imp-context';
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

  // fills the new imp's disk; a reflink clone of the image rootfs by default
  readonly prepareDisk?: (target: string) => Promise<void>;
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

  // snapshot memory to disk and stop Firecracker (DESIGN 2.8)
  readonly sleepImp: (name: string) => Promise<Imp>;

  // a sleeping imp resumes from its snapshot, a stopped one boots cold
  readonly wakeImp: (name: string) => Promise<Imp>;

  // keeps the imp awake until now + seconds; 0 releases; wakes it if needed
  readonly holdImp: (name: string, seconds: number) => Promise<Imp>;
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
      const created = await createImpRecord(context, input, image);

      context.emitChanged();

      return lock.withImpId(created.id, async (imp) => {
        // a destroy that won the race for the new imp's lock
        if (imp === undefined) {
          throw buildNotFoundError('imp', created.name);
        }

        const paths = context.findPaths(imp.id);
        const started = performance.now();

        try {
          mkdirSync(paths.runDir, { recursive: true });

          await (
            input.prepareDisk ??
            ((disk) => context.cloneDisk(context.images.getRootfsPath(image), disk))
          )(paths.disk);
        } catch (error) {
          await ops.writeFailure(imp, error);

          throw error;
        }

        const cloneMs = Math.round(performance.now() - started);

        context.log(`impd: ${imp.name}: disk cloned in ${String(cloneMs)}ms`);

        try {
          const running = await ops.startImpVm(imp);

          return await presenter.toApi(running);
        } catch (error) {
          // the governor turned the boot away before any tap or VM existed: a
          // create that cannot run leaves no imp behind
          if (isRamBudgetError(error)) {
            rmSync(paths.dir, { recursive: true, force: true });

            await removeImp(context.db, imp.id);

            context.emitChanged();
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

        await context.taps.removeTap(context.findAddress(imp.slot).tap);

        rmSync(paths.dir, { recursive: true, force: true });
        context.admission?.release(imp.id);

        await removeImp(context.db, imp.id);
      });

      context.emitChanged();
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

    wakeImp: (name) =>
      lock.withImp(name, async (imp) => {
        const running = await ops.requireRunningImp(imp);

        return presenter.toApi(running);
      }),

    holdImp: (name, seconds) =>
      lock.withImp(name, async (imp) => {
        const until = seconds > 0 ? new Date(Date.now() + seconds * 1000) : null;

        const updated = await updateImpHold(context.db, imp.id, until);

        const held = toLockedImp(imp, updated);

        if (until === null) {
          return presenter.toApi(held);
        }

        await updateImpActivity(context.db, imp.id, new Date());

        const running = await ops.requireRunningImp(held);

        return presenter.toApi(running);
      }),
  };
}
