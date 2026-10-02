import type { Imp } from '@imp/api';
import { buildLeaseNotHeldError, buildLeasedError } from '../api-errors';
import type { Caller } from '../auth/caller';
import { listImps, updateImpActivity } from '../db/imps';
import {
  HOLD_LABEL,
  LEGACY_PRINCIPAL,
  isBlockingLease,
  listLeases,
  removeLeases,
  writeLease,
} from '../db/leases';
import type { LeaseRecord } from '../db/leases';
import type { ImpContext } from './imp-context';
import { toLockedImp } from './imp-lock';
import type { ImpLock, LockedImp } from './imp-lock';
import type { ImpPresenter } from './imp-presenter';
import type { ImpVmOps } from './imp-vm-ops';

// who a lease belongs to: the caller's principal, and its name for people
type LeaseHolder = Pick<Caller, 'principal' | 'display'>;

// a lease with its imp's name
interface NamedLease {
  readonly name: string;
  readonly lease: LeaseRecord;
}

// Each owner's hold on an imp (docs/guides/leases.md). Every call takes the
// imp's lock, so a forced sleep or stop never races a write.
export interface ImpLeases {
  // wakes or boots the imp, then creates the lease or moves its end later;
  // a refused boot writes nothing
  readonly acquireLease: (
    name: string,
    holder: LeaseHolder,
    label: string,
    ttlSeconds: number,
  ) => Promise<NamedLease>;

  // moves a live lease's end later; LEASE_NOT_HELD otherwise, waking nothing
  readonly renewLease: (
    name: string,
    holder: LeaseHolder,
    label: string,
    ttlSeconds: number,
  ) => Promise<NamedLease>;

  // whether the holder had the lease
  readonly releaseLease: (name: string, holder: LeaseHolder, label: string) => Promise<boolean>;

  // live leases of every imp, by imp name
  readonly listLeases: () => Promise<NamedLease[]>;

  // live leases by imp id, for the imps the API shows
  readonly readLeases: (impIds: readonly string[]) => Promise<Map<string, LeaseRecord[]>>;

  // the holder's `hold` lease, written before the boot so a refused boot
  // keeps it; 0 releases it and a legacy hold
  readonly holdImp: (name: string, seconds: number, holder: LeaseHolder) => Promise<Imp>;

  // under the imp's lock, before a user's sleep or stop: LEASED while a
  // lease from leases.* lives, unless `force` ends them all
  readonly requireUnleased: (imp: LockedImp, force: boolean) => Promise<LockedImp>;
}

interface ImpLeaseParts {
  readonly context: ImpContext;
  readonly lock: ImpLock;
  readonly ops: ImpVmOps;
  readonly presenter: ImpPresenter;
}

export function createImpLeases(parts: ImpLeaseParts): ImpLeases {
  const context = parts.context;
  const lock = parts.lock;
  const ops = parts.ops;
  const presenter = parts.presenter;

  const findLease = async (impId: string, principal: string, label: string, at: number) => {
    const leases = await listLeases(context.db, at, [impId]);

    return leases.find((lease) => lease.principal === principal && lease.label === label);
  };

  return {
    acquireLease: (name, holder, label, ttlSeconds) =>
      lock.withImp(name, async (imp) => {
        await updateImpActivity(context.db, imp.id, new Date());

        await ops.requireRunningImp(imp);

        const at = context.now();

        const live = await findLease(imp.id, holder.principal, label, at);

        const lease: LeaseRecord = {
          impId: imp.id,
          principal: holder.principal,
          label,
          display: holder.display,
          until: buildLeaseEnd(live, at, ttlSeconds),
          createdAt: live?.createdAt ?? new Date(at),
        };

        await writeLease(context.db, lease, { at, reason: 'held' });

        return { name: imp.name, lease };
      }),

    renewLease: (name, holder, label, ttlSeconds) =>
      lock.withImp(name, async (imp) => {
        const at = context.now();

        const live = await findLease(imp.id, holder.principal, label, at);

        if (live === undefined) {
          throw buildLeaseNotHeldError(imp.name, label);
        }

        const lease: LeaseRecord = {
          ...live,
          display: holder.display,
          until: buildLeaseEnd(live, at, ttlSeconds),
        };

        await writeLease(context.db, lease, { at, reason: null });

        return { name: imp.name, lease };
      }),

    releaseLease: (name, holder, label) =>
      lock.withImp(name, async (imp) => {
        const released = await removeLeases(
          context.db,
          imp.id,
          [{ principal: holder.principal, label }],
          { at: context.now(), reason: 'held' },
        );

        return released.removed > 0;
      }),

    listLeases: async () => {
      const at = context.now();

      const [imps, leases] = await Promise.all([listImps(context.db), listLeases(context.db, at)]);

      const names = new Map(imps.map((imp) => [imp.id, imp.name]));

      return leases.flatMap((lease) => {
        const name = names.get(lease.impId);

        return name === undefined ? [] : [{ name, lease }];
      });
    },

    readLeases: async (impIds) => {
      const leases = await listLeases(context.db, context.now(), impIds);

      return Map.groupBy(leases, (lease) => lease.impId);
    },

    holdImp: (name, seconds, holder) =>
      lock.withImp(name, async (imp) => {
        const at = context.now();

        if (seconds === 0) {
          const released = await removeLeases(
            context.db,
            imp.id,
            [
              { principal: holder.principal, label: HOLD_LABEL },
              { principal: LEGACY_PRINCIPAL, label: HOLD_LABEL },
            ],
            { at, reason: 'held' },
          );

          return presenter.toApi(toLockedImp(imp, released.imp));
        }

        const live = await findLease(imp.id, holder.principal, HOLD_LABEL, at);

        // a hold sets its end, longer or shorter, as it always did
        const updated = await writeLease(
          context.db,
          {
            impId: imp.id,
            principal: holder.principal,
            label: HOLD_LABEL,
            display: holder.display,
            until: new Date(at + seconds * 1000),
            createdAt: live?.createdAt ?? new Date(at),
          },
          { at, reason: 'held' },
        );

        await updateImpActivity(context.db, imp.id, new Date());

        const running = await ops.requireRunningImp(toLockedImp(imp, updated));

        return presenter.toApi(running);
      }),

    requireUnleased: async (imp, force) => {
      const at = context.now();

      const leases = await listLeases(context.db, at, [imp.id]);

      const blocking = leases.filter((lease) => isBlockingLease(lease));

      if (blocking.length === 0) {
        return imp;
      }

      if (!force) {
        throw buildLeasedError(imp.name, blocking);
      }

      const released = await removeLeases(context.db, imp.id, 'blocking', {
        at,
        reason: 'released',
      });

      context.log(
        `impd: ${imp.name}: a forced sleep or stop ended ${String(released.removed)} lease(s)`,
      );

      return toLockedImp(imp, released.imp);
    },
  };
}

// the later of the lease's end and now + ttl: a write never shortens one
function buildLeaseEnd(
  lease: LeaseRecord | undefined,
  at: number,
  ttlSeconds: number,
): Date | null {
  const until = at + ttlSeconds * 1000;

  if (lease === undefined) {
    return new Date(until);
  }

  return lease.until === null ? null : new Date(Math.max(lease.until.getTime(), until));
}
