import type { Checkpoint } from '@imp/api';
import type { Selectable } from 'kysely';
import { emitImpWrite } from './imp-write-feed';
import type { ImpDatabase } from './open-database';
import type { DatabaseSchema } from './schema';

export interface CheckpointRecord {
  readonly id: string;
  readonly impId: string;
  readonly label: string | null;
  readonly createdAt: Date;
  readonly sizeBytes: number | null;
  readonly diskBytes: number;
}

export interface NewCheckpoint {
  readonly id: string;
  readonly impId: string;
  readonly label: string | null;
  readonly sizeBytes: number | null;

  // 32 GiB when left out
  readonly diskBytes?: number;

  // now by default; a restore from backup keeps the original time
  readonly createdAt?: Date;
}

export async function createCheckpoint(
  db: ImpDatabase,
  checkpoint: NewCheckpoint,
): Promise<CheckpointRecord> {
  const row = await db
    .insertInto('checkpoints')
    .values({
      id: checkpoint.id,
      imp_id: checkpoint.impId,
      label: checkpoint.label,
      created_at: checkpoint.createdAt?.getTime() ?? Date.now(),
      size_bytes: checkpoint.sizeBytes,
      ...(checkpoint.diskBytes !== undefined && { disk_bytes: checkpoint.diskBytes }),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const created = toCheckpointRecord(row);

  emitImpWrite(db, { kind: 'checkpointAdded', checkpoint: created });

  return created;
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
  const row = await db
    .deleteFrom('checkpoints')
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();

  if (row === undefined) {
    return false;
  }

  emitImpWrite(db, { kind: 'checkpointRemoved', checkpoint: toCheckpointRecord(row) });

  return true;
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
    diskBytes: row.disk_bytes,
  };
}

export function toApiCheckpoint(checkpoint: CheckpointRecord): Checkpoint {
  return {
    id: checkpoint.id,
    createdAt: checkpoint.createdAt,
    diskMib: Math.ceil(checkpoint.diskBytes / 1_048_576),
    ...(checkpoint.label !== null && { label: checkpoint.label }),
    ...(checkpoint.sizeBytes !== null && { sizeBytes: checkpoint.sizeBytes }),
  };
}
