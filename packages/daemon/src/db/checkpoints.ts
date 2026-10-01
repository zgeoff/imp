import type { Selectable } from 'kysely';
import type { ImpDatabase } from './open-database';
import type { DatabaseSchema } from './schema';

export interface CheckpointRecord {
  readonly id: string;
  readonly impId: string;
  readonly label: string | null;
  readonly createdAt: Date;
  readonly sizeBytes: number | null;
}

export interface NewCheckpoint {
  readonly impId: string;
  readonly label: string | null;
  readonly sizeBytes: number | null;
}

export async function createCheckpoint(
  db: ImpDatabase,
  checkpoint: NewCheckpoint,
): Promise<CheckpointRecord> {
  const row = await db
    .insertInto('checkpoints')
    .values({
      id: Bun.randomUUIDv7(),
      imp_id: checkpoint.impId,
      label: checkpoint.label,
      created_at: Date.now(),
      size_bytes: checkpoint.sizeBytes,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return toCheckpointRecord(row);
}

// newest first
export async function listCheckpoints(db: ImpDatabase, impId: string): Promise<CheckpointRecord[]> {
  const rows = await db
    .selectFrom('checkpoints')
    .selectAll()
    .where('imp_id', '=', impId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();

  return rows.map((row) => toCheckpointRecord(row));
}

// `ref` is a checkpoint id or label, scoped to one imp
export async function findCheckpoint(
  db: ImpDatabase,
  impId: string,
  ref: string,
): Promise<CheckpointRecord | undefined> {
  const row = await db
    .selectFrom('checkpoints')
    .selectAll()
    .where('imp_id', '=', impId)
    .where((eb) => eb.or([eb('id', '=', ref), eb('label', '=', ref)]))
    .executeTakeFirst();

  return row === undefined ? undefined : toCheckpointRecord(row);
}

export async function removeCheckpoint(db: ImpDatabase, id: string): Promise<boolean> {
  const result = await db.deleteFrom('checkpoints').where('id', '=', id).executeTakeFirst();

  return result.numDeletedRows > 0n;
}

function toCheckpointRecord(
  row: Readonly<Selectable<DatabaseSchema['checkpoints']>>,
): CheckpointRecord {
  return {
    id: row.id,
    impId: row.imp_id,
    label: row.label,
    createdAt: new Date(row.created_at),
    sizeBytes: row.size_bytes,
  };
}
