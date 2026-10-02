import type { AuditEntry } from '@imp/api';
import type { ImpDatabase } from './open-database';

// the newest rows an imp keeps; older ones go as new ones come
export const AUDIT_ROWS_PER_IMP = 1000;

export interface NewAuditEntry {
  readonly impId: string;
  readonly secretName: string;
  readonly at: Date;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly status: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly durationMs: number;
}

export async function writeAuditEntry(db: ImpDatabase, entry: NewAuditEntry): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('broker_audit')
      .values({
        imp_id: entry.impId,
        secret_name: entry.secretName,
        at: entry.at.getTime(),
        method: entry.method,
        host: entry.host,
        path: entry.path,
        status: entry.status,
        request_bytes: entry.requestBytes,
        response_bytes: entry.responseBytes,
        duration_ms: entry.durationMs,
      })
      .execute();

    // the id of the newest row past the cap, if there is one
    const cut = await trx
      .selectFrom('broker_audit')
      .select('id')
      .where('imp_id', '=', entry.impId)
      .orderBy('id', 'desc')
      .offset(AUDIT_ROWS_PER_IMP)
      .limit(1)
      .executeTakeFirst();

    if (cut !== undefined) {
      await trx
        .deleteFrom('broker_audit')
        .where('imp_id', '=', entry.impId)
        .where('id', '<=', cut.id)
        .execute();
    }
  });
}

// newest first; one imp's when impId is set
export async function listAuditEntries(
  db: ImpDatabase,
  impId: string | null,
  limit: number,
): Promise<AuditEntry[]> {
  const base = db
    .selectFrom('broker_audit')
    .innerJoin('imps', 'imps.id', 'broker_audit.imp_id')
    .select([
      'imps.name',
      'broker_audit.secret_name',
      'broker_audit.at',
      'broker_audit.method',
      'broker_audit.host',
      'broker_audit.path',
      'broker_audit.status',
      'broker_audit.request_bytes',
      'broker_audit.response_bytes',
      'broker_audit.duration_ms',
    ])
    .orderBy('broker_audit.id', 'desc')
    .limit(limit);

  const rows = await (
    impId === null ? base : base.where('broker_audit.imp_id', '=', impId)
  ).execute();

  return rows.map((row) => ({
    at: new Date(row.at),
    imp: row.name,
    secret: row.secret_name,
    method: row.method,
    host: row.host,
    path: row.path,
    status: row.status,
    requestBytes: row.request_bytes,
    responseBytes: row.response_bytes,
    durationMs: row.duration_ms,
  }));
}
