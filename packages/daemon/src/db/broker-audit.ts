import type { AuditEntry, AuditRefusal } from '@imp/api';
import { toLikePattern } from '../auth/imp-patterns';
import type { ImpDatabase } from './open-database';

// the newest rows an imp keeps of each kind, sent and refused; older ones go
// as new ones of their kind come, so a guest's refusals never push out the
// requests sent with a credential
export const AUDIT_ROWS_PER_IMP = 1000;

// A request the broker sent with a credential, with reason null, or one it
// refused, with no secret. Nothing from a header or a body is kept.
export interface NewAuditEntry {
  readonly impId: string;
  readonly secretName: string | null;
  readonly at: Date;
  readonly method: string | null;
  readonly host: string | null;
  readonly path: string | null;
  readonly status: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly durationMs: number;
  readonly reason: AuditRefusal | null;
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
        reason: entry.reason,
      })
      .execute();

    const sameKind = entry.reason === null ? 'is' : 'is not';

    // the id of the newest row of the entry's kind past the cap, if there is one
    const cut = await trx
      .selectFrom('broker_audit')
      .select('id')
      .where('imp_id', '=', entry.impId)
      .where('reason', sameKind, null)
      .orderBy('id', 'desc')
      .offset(AUDIT_ROWS_PER_IMP)
      .limit(1)
      .executeTakeFirst();

    if (cut !== undefined) {
      await trx
        .deleteFrom('broker_audit')
        .where('imp_id', '=', entry.impId)
        .where('reason', sameKind, null)
        .where('id', '<=', cut.id)
        .execute();
    }
  });
}

// newest first; one imp's when impId is set, and only imps within the
// patterns when there are any
export async function listAuditEntries(
  db: ImpDatabase,
  impId: string | null,
  limit: number,
  patterns: readonly string[] | null,
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
      'broker_audit.reason',
    ])
    .orderBy('broker_audit.id', 'desc')
    .limit(limit);

  const named = impId === null ? base : base.where('broker_audit.imp_id', '=', impId);

  const rows = await (
    patterns === null
      ? named
      : named.where((eb) =>
          eb.or(patterns.map((pattern) => eb('imps.name', 'like', toLikePattern(pattern)))),
        )
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
    reason: row.reason,
  }));
}
