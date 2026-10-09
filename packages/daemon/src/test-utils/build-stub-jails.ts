import { existsSync } from 'node:fs';
import type { Jails } from '../vmm/jail';

interface StubJailsOptions {
  // the command a prepare hands back; without one a prepare rejects, as for
  // a VM that must run unjailed
  readonly argv?: readonly string[];

  // gets each note as it is made, besides `notes`, such as a log the stub
  // VMM appends to as well
  readonly onNote?: (note: string) => void;
}

// The jails of the VM runner and template VMs, without mounts or root: each
// call is noted in order, and each plan a prepare gets is kept.
export function buildStubJails(options: Readonly<StubJailsOptions> = {}) {
  const notes: string[] = [];
  const plans: unknown[] = [];
  const refusals: { prepare: Error | null; seal: Error | null } = { prepare: null, seal: null };

  const writeNote = (note: string): void => {
    notes.push(note);
    options.onNote?.(note);
  };

  const readArgv = (): Promise<readonly string[]> => {
    if (refusals.prepare !== null) {
      return Promise.reject(refusals.prepare);
    }

    return options.argv === undefined
      ? Promise.reject(new Error('no jail command given'))
      : Promise.resolve(options.argv);
  };

  const jails: Jails = {
    prepare: (plan) => {
      plans.push(plan);

      writeNote(
        `prepare ${plan.impId} late=${String(plan.isDiskLate === true)} disk=${String(existsSync(plan.paths.disk))}`,
      );

      return readArgv();
    },
    prepareBuild: (plan) => {
      plans.push(plan);

      writeNote(`prepare build ${plan.id}`);

      return readArgv();
    },
    setupDiskOwner: (paths) => {
      writeNote(`own disk=${String(existsSync(paths.disk))}`);
    },
    release: (id) => {
      writeNote(`release ${id}`);

      return Promise.resolve();
    },
    sweepRunDir: (paths) => {
      writeNote(`sweep ${paths.impId}`);

      return Promise.resolve();
    },
    remove: (id) => {
      writeNote(`remove ${id}`);

      return Promise.resolve();
    },
    removeOrphans: () => Promise.resolve([]),
    seal: () => {
      writeNote('seal');

      if (refusals.seal !== null) {
        throw refusals.seal;
      }
    },
  };

  return {
    jails,
    notes,
    plans,

    // from now on each prepare rejects with `error`, as a bind mount that fails
    refusePrepare: (error: Error): void => {
      refusals.prepare = error;
    },

    // from now on each seal throws `error`, as one that finds run/ planted
    refuseSeal: (error: Error): void => {
      refusals.seal = error;
    },
  };
}
