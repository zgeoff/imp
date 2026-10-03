import type { ImpChangeReason } from '@imp/api';
import type { Selectable } from 'kysely';
import { emitImpWrite } from './imp-write-feed';
import { updateImpHold } from './imps';
import type { ImpRecord } from './imps';
import type { ImpDatabase } from './open-database';
import type { ImpLeasesTable } from './schema';

// the owner of a hold from before leases, and the label `imps.hold` writes;
// neither blocks a user's sleep or stop (docs/guides/leases.md#holds)
export const LEGACY_PRINCIPAL = 'legacy';
export const HOLD_LABEL = 'hold';

export interface LeaseRecord {
  readonly impId: string;
  readonly principal: string;
  readonly label: string;
  readonly display: string;

  // null holds with no end
  readonly until: Date | null;
  readonly createdAt: Date;
}

// one owner's lease on an imp
export interface LeaseKey {
  readonly principal: string;
  readonly label: string;
}

// which leases a removal takes: these keys, or every one made through
// `leases.*`
type LeaseSelection = readonly LeaseKey[] | 'blocking';

interface LeaseWrite {
  // the clock's now: what ended before it is pruned
  readonly at: number;

  // the ImpChanged reason it emits; null for none, as a renew
  readonly reason: ImpChangeReason | null;

  // a removal emits even when it took nothing, as `hold 0` always has
  readonly isEmittedWhenNone?: boolean;
}

// Only a lease made through `leases.*` blocks a user's sleep or stop: the
// `hold` label and a legacy hold never did.
export function isBlockingLease(lease: Readonly<LeaseKey>): boolean {
  return lease.principal !== LEGACY_PRINCIPAL && lease.label !== HOLD_LABEL;
}

// the leases still live at `at`, of these imps or of all of them, oldest
// first
export async function listLeases(
  db: ImpDatabase,
  at: number,
  impIds?: readonly string[],
): Promise<LeaseRecord[]> {
  if (impIds?.length === 0) {
    return [];
  }

  let query = db
    .selectFrom('imp_leases')
    .selectAll()
    .where((eb) => eb.or([eb('until', 'is', null), eb('until', '>', at)]));

  if (impIds !== undefined) {
    query = query.where('imp_id', 'in', impIds);
  }

  const rows = await query.orderBy('created_at').orderBy('principal').orderBy('label').execute();

  return rows.map((row) => toLeaseRecord(row));
}

// Creates the lease or moves its end, keeping when it was made, then the
// imp's hold. Leases that ended go first, so one that comes back is new.
export async function writeLease(
  db: ImpDatabase,
  lease: Readonly<LeaseRecord>,
  write: Readonly<LeaseWrite>,
): Promise<ImpRecord> {
  const imp = await db.transaction().execute(async (trx) => {
    await removeEndedLeases(trx, lease.impId, write.at);

    await trx
      .insertInto('imp_leases')
      .values({
        imp_id: lease.impId,
        principal: lease.principal,
        label: lease.label,
        display: lease.display,
        until: lease.until?.getTime() ?? null,
        created_at: lease.createdAt.getTime(),
      })
      .onConflict((oc) =>
        oc.columns(['imp_id', 'principal', 'label']).doUpdateSet({
          display: lease.display,
          until: lease.until?.getTime() ?? null,
        }),
      )
      .execute();

    return updateImpHold(trx, lease.impId);
  });

  if (write.reason !== null) {
    emitImpWrite(db, { kind: 'changed', imp, reason: write.reason });
  }

  return imp;
}

// Removes the leases, then sets the imp's hold. It emits only when one went,
// unless told otherwise; `released` says how many.
export async function removeLeases(
  db: ImpDatabase,
  impId: string,
  which: LeaseSelection,
  write: Readonly<LeaseWrite>,
): Promise<{ readonly removed: number; readonly imp: ImpRecord }> {
  const result = await db.transaction().execute(async (trx) => {
    await removeEndedLeases(trx, impId, write.at);

    let query = trx.deleteFrom('imp_leases').where('imp_id', '=', impId);

    query =
      which === 'blocking'
        ? query.where('principal', '!=', LEGACY_PRINCIPAL).where('label', '!=', HOLD_LABEL)
        : query.where((eb) =>
            eb.or(
              which.map((key) =>
                eb.and([eb('principal', '=', key.principal), eb('label', '=', key.label)]),
              ),
            ),
          );

    const isNone = which !== 'blocking' && which.length === 0;
    const deleted = isNone ? [] : await query.returning('label').execute();

    return { removed: deleted.length, imp: await updateImpHold(trx, impId) };
  });

  if (write.reason !== null && (result.removed > 0 || write.isEmittedWhenNone === true)) {
    emitImpWrite(db, {
      kind: 'changed',
      imp: result.imp,
      reason: write.reason,
      ...(write.reason === 'released' && { detail: { released: result.removed } }),
    });
  }

  return result;
}

// A moved imp's leases, as its target staged it: written with the imp's
// hold, which emits nothing, as no imp of that name lives here yet. A pair
// a header names twice keeps its last.
export async function writeMovedLeases(
  db: ImpDatabase,
  impId: string,
  leases: readonly Readonly<Omit<LeaseRecord, 'impId'>>[],
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const lease of leases) {
      const until = lease.until?.getTime() ?? null;

      await trx
        .insertInto('imp_leases')
        .values({
          imp_id: impId,
          principal: lease.principal,
          label: lease.label,
          display: lease.display,
          until,
          created_at: lease.createdAt.getTime(),
        })
        .onConflict((oc) =>
          oc
            .columns(['imp_id', 'principal', 'label'])
            .doUpdateSet({ display: lease.display, until }),
        )
        .execute();
    }

    await updateImpHold(trx, impId);
  });
}

async function removeEndedLeases(db: ImpDatabase, impId: string, at: number): Promise<void> {
  await db
    .deleteFrom('imp_leases')
    .where('imp_id', '=', impId)
    .where('until', 'is not', null)
    .where('until', '<=', at)
    .execute();
}

function toLeaseRecord(row: Readonly<Selectable<ImpLeasesTable>>): LeaseRecord {
  return {
    impId: row.imp_id,
    principal: row.principal,
    label: row.label,
    display: row.display,
    until: row.until === null ? null : new Date(row.until),
    createdAt: new Date(row.created_at),
  };
}
