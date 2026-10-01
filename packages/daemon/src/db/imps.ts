import type { ImpState } from '@imp/api';
import type { Selectable, Updateable } from 'kysely';
import type { ImpDatabase } from './open-database';
import type { DatabaseSchema } from './schema';

type ImpRow = Selectable<DatabaseSchema['imps']>;

export interface ImpRecord {
  readonly id: string;
  readonly name: string;
  readonly imageId: string;
  readonly state: ImpState;
  readonly vcpus: number;
  readonly memoryMib: number;
  readonly slot: number;
  readonly ip: string;
  readonly createdAt: Date;
  readonly lastActiveAt: Date;
  readonly sleptAt: Date | null;
  readonly holdUntil: Date | null;
  readonly error: string | null;
  readonly pid: number | null;
  readonly firecrackerVersion: string | null;
}

export interface NewImp {
  readonly name: string;
  readonly imageId: string;
  readonly vcpus: number;
  readonly memoryMib: number;
  readonly slot: number;
  readonly ip: string;
}

export interface ImpStateChange {
  readonly state: ImpState;
  readonly error?: string | null;
  readonly pid?: number | null;
  readonly sleptAt?: Date | null;
  readonly firecrackerVersion?: string | null;
}

// The lowest slot no imp holds. Run it in the same transaction as the insert
// that takes the slot; the unique index on `slot` backs that up.
export async function allocateSlot(db: ImpDatabase, slotCount: number): Promise<number> {
  const rows = await db.selectFrom('imps').select('slot').orderBy('slot').execute();

  let slot = 0;

  for (const row of rows) {
    if (row.slot !== slot) {
      break;
    }

    slot += 1;
  }

  if (slot >= slotCount) {
    throw new Error(`every one of the ${String(slotCount)} slots is taken`);
  }

  return slot;
}

export async function createImp(db: ImpDatabase, imp: NewImp): Promise<ImpRecord> {
  const now = Date.now();

  const row = await db
    .insertInto('imps')
    .values({
      id: Bun.randomUUIDv7(),
      name: imp.name,
      image_id: imp.imageId,
      state: 'creating',
      vcpus: imp.vcpus,
      memory_mib: imp.memoryMib,
      slot: imp.slot,
      ip: imp.ip,
      created_at: now,
      last_active_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return toImpRecord(row);
}

export async function findImpByName(db: ImpDatabase, name: string): Promise<ImpRecord | undefined> {
  const row = await db.selectFrom('imps').selectAll().where('name', '=', name).executeTakeFirst();

  return row === undefined ? undefined : toImpRecord(row);
}

export async function findImpById(db: ImpDatabase, id: string): Promise<ImpRecord | undefined> {
  const row = await db.selectFrom('imps').selectAll().where('id', '=', id).executeTakeFirst();

  return row === undefined ? undefined : toImpRecord(row);
}

export async function listImps(db: ImpDatabase): Promise<ImpRecord[]> {
  const rows = await db.selectFrom('imps').selectAll().orderBy('name').execute();

  return rows.map((row) => toImpRecord(row));
}

export async function countImps(db: ImpDatabase, state?: ImpState): Promise<number> {
  let query = db.selectFrom('imps').select((eb) => eb.fn.countAll<number>().as('count'));

  if (state !== undefined) {
    query = query.where('state', '=', state);
  }

  const row = await query.executeTakeFirstOrThrow();

  return row.count;
}

// Fields the change leaves out keep their value; null clears one.
export async function updateImpState(
  db: ImpDatabase,
  id: string,
  change: Readonly<ImpStateChange>,
): Promise<ImpRecord> {
  const values: Updateable<DatabaseSchema['imps']> = { state: change.state };

  if (change.error !== undefined) {
    values.error = change.error;
  }

  if (change.pid !== undefined) {
    values.pid = change.pid;
  }

  if (change.sleptAt !== undefined) {
    values.slept_at = change.sleptAt === null ? null : change.sleptAt.getTime();
  }

  if (change.firecrackerVersion !== undefined) {
    values.firecracker_version = change.firecrackerVersion;
  }

  const row = await db
    .updateTable('imps')
    .set(values)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return toImpRecord(row);
}

export async function updateImpActivity(db: ImpDatabase, id: string, at: Date): Promise<void> {
  await db.updateTable('imps').set({ last_active_at: at.getTime() }).where('id', '=', id).execute();
}

export async function updateImpHold(
  db: ImpDatabase,
  id: string,
  until: Date | null,
): Promise<ImpRecord> {
  const row = await db
    .updateTable('imps')
    .set({ hold_until: until === null ? null : until.getTime() })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return toImpRecord(row);
}

// cascades to the imp's checkpoints
export async function removeImp(db: ImpDatabase, id: string): Promise<boolean> {
  const result = await db.deleteFrom('imps').where('id', '=', id).executeTakeFirst();

  return result.numDeletedRows > 0n;
}

function toImpRecord(row: Readonly<ImpRow>): ImpRecord {
  return {
    id: row.id,
    name: row.name,
    imageId: row.image_id,
    state: row.state,
    vcpus: row.vcpus,
    memoryMib: row.memory_mib,
    slot: row.slot,
    ip: row.ip,
    createdAt: new Date(row.created_at),
    lastActiveAt: new Date(row.last_active_at),
    sleptAt: toDate(row.slept_at),
    holdUntil: toDate(row.hold_until),
    error: row.error,
    pid: row.pid,
    firecrackerVersion: row.firecracker_version,
  };
}

function toDate(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms);
}

export async function countImpsUsingImage(db: ImpDatabase, imageId: string): Promise<number> {
  const row = await db
    .selectFrom('imps')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('image_id', '=', imageId)
    .executeTakeFirstOrThrow();

  return row.count;
}
