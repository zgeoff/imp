import type { ColdBoot, ColdBootCause } from '@imp/api';
import type { Transaction } from 'kysely';
import type { ImpDatabase } from './open-database';
import type { DatabaseSchema } from './schema';

// An imp's last cold boots (docs/architecture/daemon.md#output-offsets): each
// one ended every session generation before it, so a client that reconnects
// learns why its output is gone.

const KEPT_BOOTS = 4;

interface BootRecord {
  readonly bootId: string;
  readonly cause: ColdBootCause;
  readonly at: Date;
}

// The boot a booted guest's agent reported. A cause impd learned before the
// boot (`recovery`, `restore`) wins over a plain `start`, and is spent.
export async function writeColdBoot(
  db: ImpDatabase,
  impId: string,
  boot: Readonly<BootRecord>,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('imps')
      .select('next_boot_cause')
      .where('id', '=', impId)
      .executeTakeFirst();

    const pending = row?.next_boot_cause ?? null;

    await writeBootRow(trx, impId, {
      ...boot,
      cause: boot.cause === 'start' && pending !== null ? pending : boot.cause,
    });

    await trx.updateTable('imps').set({ next_boot_cause: null }).where('id', '=', impId).execute();
  });
}

// A boot impd has no record of, as when it adopts a VM booted before cold
// boots were kept: `unknown`, unless a row for it exists.
export async function writeUnknownBoot(
  db: ImpDatabase,
  impId: string,
  bootId: string,
  at: Date,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await writeBootRow(trx, impId, { bootId, cause: 'unknown', at });
  });
}

// the cause the imp's next cold boot records, whichever path boots it
export async function writeNextBootCause(
  db: ImpDatabase,
  impId: string,
  cause: Extract<ColdBootCause, 'recovery' | 'restore'>,
): Promise<void> {
  await db.updateTable('imps').set({ next_boot_cause: cause }).where('id', '=', impId).execute();
}

// A boot with no boot_id (an agent that could not read it) records no row,
// but it still spends the cause pending for it: a later boot must not
// inherit it.
export async function removeNextBootCause(db: ImpDatabase, impId: string): Promise<void> {
  await db.updateTable('imps').set({ next_boot_cause: null }).where('id', '=', impId).execute();
}

// newest first
export async function listColdBoots(db: ImpDatabase, impId: string): Promise<ColdBoot[]> {
  const rows = await db
    .selectFrom('imp_cold_boots')
    .selectAll()
    .where('imp_id', '=', impId)
    .orderBy('seq', 'desc')
    .limit(KEPT_BOOTS)
    .execute();

  return rows.map((row) => ({
    bootId: row.boot_id,
    cause: row.cause,
    at: new Date(row.at).toISOString(),
  }));
}

async function writeBootRow(
  trx: Transaction<DatabaseSchema>,
  impId: string,
  boot: Readonly<BootRecord>,
): Promise<void> {
  await trx
    .insertInto('imp_cold_boots')
    .values({ imp_id: impId, boot_id: boot.bootId, cause: boot.cause, at: boot.at.getTime() })
    .onConflict((conflict) => conflict.columns(['imp_id', 'boot_id']).doNothing())
    .execute();

  const kept = trx
    .selectFrom('imp_cold_boots')
    .select('boot_id')
    .where('imp_id', '=', impId)
    .orderBy('seq', 'desc')
    .limit(KEPT_BOOTS);

  await trx
    .deleteFrom('imp_cold_boots')
    .where('imp_id', '=', impId)
    .where('boot_id', 'not in', kept)
    .execute();
}
