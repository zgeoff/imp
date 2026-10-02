import { buildNotFoundError } from '../api-errors';
import { findImpById, findImpByName } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpContext } from './imp-context';
import { checkLiveness } from './imp-liveness';
import { createKeyedMutex } from './keyed-mutex';
import type { TryResult } from './keyed-mutex';

const LOCKED = Symbol('locked');

// An imp record read under the imp's lifecycle lock. Only this module makes
// one, so the VM operations that take it cannot run without the lock.
export type LockedImp = ImpRecord & { readonly [LOCKED]: true };

export interface ImpLock {
  // the imp by name, checked for a dead VM or a lost snapshot, without the lock
  readonly findImp: (name: string) => Promise<ImpRecord>;

  // runs `action` under the imp's lock with a fresh record; NOT_FOUND when
  // the imp is gone by the time the lock is free
  readonly withImp: <T>(name: string, action: (imp: LockedImp) => Promise<T>) => Promise<T>;
  readonly withImpId: <T>(
    id: string,
    action: (imp: LockedImp | undefined) => Promise<T>,
  ) => Promise<T>;

  // for a new imp: `insert` writes its record under the lock it is created
  // with, so no other operation can reach the imp before `action` holds it
  readonly withNewImp: <T>(
    id: string,
    insert: () => Promise<ImpRecord>,
    action: (imp: LockedImp) => Promise<T>,
  ) => Promise<T>;

  // as withImpId, but only when nothing holds or waits for the lock
  readonly tryWithImpId: <T>(
    id: string,
    action: (imp: LockedImp | undefined) => Promise<T>,
  ) => Promise<TryResult<T>>;

  // true while a lifecycle operation runs or waits on the imp
  readonly isLocked: (id: string) => boolean;

  // resolves once no lifecycle operation runs or waits on any imp
  readonly waitForAll: () => Promise<void>;
}

// The record an operation under the lock wrote: still under the same lock.
export function toLockedImp(held: LockedImp, next: ImpRecord): LockedImp {
  if (next.id !== held.id) {
    throw new Error(`imp ${next.id} is not the locked imp ${held.id}`);
  }

  return { ...next, [LOCKED]: true };
}

export function createImpLock(context: ImpContext): ImpLock {
  const mutex = createKeyedMutex();

  // the lock is held: a dead VM can be marked stopped right away
  const readLocked = async (id: string): Promise<LockedImp | undefined> => {
    const imp = await findImpById(context.db, id);

    if (imp === undefined) {
      return undefined;
    }

    const live = await checkLiveness(context, imp, true);

    return { ...live, [LOCKED]: true };
  };

  const findImp = async (name: string): Promise<ImpRecord> => {
    const imp = await findImpByName(context.db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return checkLiveness(context, imp, !mutex.isLocked(imp.id));
  };

  return {
    findImp,
    withImp: async (name, action) => {
      const found = await findImp(name);

      return mutex.runExclusive(found.id, async () => {
        const imp = await readLocked(found.id);

        if (imp === undefined) {
          throw buildNotFoundError('imp', name);
        }

        return action(imp);
      });
    },
    withImpId: (id, action) =>
      mutex.runExclusive(id, async () => {
        const imp = await readLocked(id);

        return action(imp);
      }),
    withNewImp: (id, insert, action) =>
      mutex.runExclusive(id, async () => {
        const imp = await insert();

        return action({ ...imp, [LOCKED]: true });
      }),
    tryWithImpId: (id, action) =>
      mutex.tryRunExclusive(id, async () => {
        const imp = await readLocked(id);

        return action(imp);
      }),
    isLocked: (id) => mutex.isLocked(id),
    waitForAll: () => mutex.waitForAll(),
  };
}
