import { buildMovingError, buildNotFoundError, isMovingError } from '../api-errors';
import { findImpById, findImpByName } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { createKeyedMutex } from '../process/keyed-mutex';
import type { TryResult } from '../process/keyed-mutex';
import { withImpLogContext } from '../process/with-imp-log-context';
import type { ImpContext } from './imp-context';
import { checkLiveness } from './imp-liveness';

const LOCKED = Symbol('locked');

// a try that found the imp moving: it refuses as a held lock does
const MOVING: unique symbol = Symbol('moving');

// One callback's hold on an imp's lock, shared by every record read or
// written under it; it ends with the callback.
interface LockHold {
  isHeld: boolean;
}

// An imp record read under the imp's lifecycle lock. Only this module makes
// one, so the VM operations that take it cannot run without the lock.
export type LockedImp = ImpRecord & { readonly [LOCKED]: LockHold };

interface WithImpOptions {
  // the move's own steps, which act on an imp they marked
  readonly isMove?: boolean;
}

export interface ImpLock {
  // the imp by name, checked for a dead VM or a lost snapshot, without the lock
  readonly findImp: (name: string) => Promise<ImpRecord>;

  // runs `action` under the imp's lock with a fresh record; NOT_FOUND when
  // the imp is gone by the time the lock is free, MOVING while it moves
  // between hosts, unless `isMove` says the move itself calls
  readonly withImp: <T>(
    name: string,
    action: (imp: LockedImp) => Promise<T>,
    options?: WithImpOptions,
  ) => Promise<T>;

  // as withImp, by id: a gone imp reaches `action` as undefined
  readonly withImpId: <T>(
    id: string,
    action: (imp: LockedImp | undefined) => Promise<T>,
    options?: WithImpOptions,
  ) => Promise<T>;

  // for a new imp: `insert` writes its record under the lock it is created
  // with, so no other operation can reach the imp before `action` holds it
  readonly withNewImp: <T>(
    id: string,
    insert: () => Promise<ImpRecord>,
    action: (imp: LockedImp) => Promise<T>,
  ) => Promise<T>;

  // as withImpId, but only when nothing holds or waits for the lock; a moving
  // imp counts as held, so the try does not run
  readonly tryWithImpId: <T>(
    id: string,
    action: (imp: LockedImp | undefined) => Promise<T>,
    options?: WithImpOptions,
  ) => Promise<TryResult<T>>;

  // true while a lifecycle operation runs or waits on the imp
  readonly isLocked: (id: string) => boolean;

  // the lifecycle operations that run or wait on the imp: 2 once a second
  // one queues behind the first
  readonly countQueued: (id: string) => number;

  // resolves once no lifecycle operation runs or waits on any imp
  readonly waitForAll: () => Promise<void>;
}

// A record only the lock made, while its callback still holds the lock: a
// cast or a record kept past the callback cannot stand in for the lock.
export function isLockedImp(imp: ImpRecord & { readonly [LOCKED]?: LockHold }): imp is LockedImp {
  return imp[LOCKED]?.isHeld === true;
}

// The record an operation under the lock wrote: still under the same lock.
export function toLockedImp(held: LockedImp, next: ImpRecord): LockedImp {
  if (next.id !== held.id) {
    throw new Error(`imp ${next.id} is not the locked imp ${held.id}`);
  }

  return { ...next, [LOCKED]: held[LOCKED] };
}

export function createImpLock(context: ImpContext): ImpLock {
  const mutex = createKeyedMutex();

  // per imp, the operations queued on its lock, the running one included
  const queued = new Map<string, number>();

  const runCounted = async <T>(id: string, task: () => Promise<T>): Promise<T> => {
    queued.set(id, (queued.get(id) ?? 0) + 1);

    try {
      return await task();
    } finally {
      const left = (queued.get(id) ?? 1) - 1;

      if (left === 0) {
        queued.delete(id);
      } else {
        queued.set(id, left);
      }
    }
  };

  // counted from the moment it queues, until it is done
  const runExclusive = <T>(id: string, task: () => Promise<T>) =>
    runCounted(id, () => mutex.runExclusive(id, task));

  // under the imp's lock, inside the storage gate: the GC never runs while an
  // operation may have storage its rows do not name yet
  const runJoined = <T>(task: () => Promise<T>) => context.storageGate.join(task);

  // the lock is held: a dead VM can be marked stopped right away. Every way
  // into the lock reads here, so a moving imp reaches only its move's steps.
  const readLocked = async (
    id: string,
    options: WithImpOptions,
  ): Promise<LockedImp | undefined> => {
    const imp = await findImpById(context.db, id);

    if (imp === undefined) {
      return undefined;
    }

    const live = await checkLiveness(context, imp, true);

    if (live.moveState !== null && options.isMove !== true) {
      throw buildMovingError(live.name);
    }

    return { ...live, [LOCKED]: { isHeld: true } };
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
    withImp: async (name, action, options = {}) => {
      const found = await findImp(name);

      return runExclusive(found.id, () =>
        runJoined(async () => {
          const imp = await readLocked(found.id, options);

          if (imp === undefined) {
            throw buildNotFoundError('imp', name);
          }

          return runAbout(imp, action);
        }),
      );
    },
    withImpId: (id, action, options = {}) =>
      runExclusive(id, () =>
        runJoined(async () => {
          const imp = await readLocked(id, options);

          return runAbout(imp, action);
        }),
      ),
    withNewImp: (id, insert, action) =>
      runExclusive(id, () =>
        runJoined(async () => {
          const imp = await insert();

          return runAbout({ ...imp, [LOCKED]: { isHeld: true } }, action);
        }),
      ),

    // counted only once it runs: a refused try never queued
    tryWithImpId: async (id, action, options = {}) => {
      const result = await mutex.tryRunExclusive(id, () =>
        runCounted(id, () =>
          runJoined(async () => {
            const imp = await readLocked(id, options).catch((error: unknown): typeof MOVING => {
              if (isMovingError(error)) {
                return MOVING;
              }

              throw error;
            });

            return imp === MOVING ? MOVING : runAbout(imp, action);
          }),
        ),
      );

      if (!result.ran) {
        return result;
      }

      return result.value === MOVING ? { ran: false } : { ran: true, value: result.value };
    },
    isLocked: (id) => mutex.isLocked(id),
    countQueued: (id) => queued.get(id) ?? 0,
    waitForAll: () => mutex.waitForAll(),
  };
}

// Runs `action` on `imp` with the imp as the imp of every log line it
// writes; a gone imp names none. The hold ends with `action`.
async function runAbout<I extends LockedImp | undefined, T>(
  imp: I,
  action: (imp: I) => Promise<T>,
): Promise<T> {
  if (imp === undefined) {
    return action(imp);
  }

  try {
    return await withImpLogContext(imp.name, () => action(imp));
  } finally {
    imp[LOCKED].isHeld = false;
  }
}
