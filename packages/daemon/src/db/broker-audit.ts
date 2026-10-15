import type { AuditEntry, AuditRefusal, RefusedRequest } from '@impz/api';
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

// The requests sent with a credential, newest first; one imp's when impId is
// set, and only imps within the patterns when there are any.
export async function listAuditEntries(
  db: ImpDatabase,
  impId: string | null,
  limit: number,
  patterns: readonly string[] | null,
): Promise<AuditEntry[]> {
  const rows = await listAuditRows(db, { impId, limit, patterns, refused: false });

  return rows.map((row) => {
    // the broker writes all four for each request it sent
    if (row.secret_name === null || row.method === null || row.host === null || row.path === null) {
      throw new Error(`broker audit row ${String(row.id)} was sent but lacks a field`);
    }

    return {
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
    };
  });
}

// The requests the broker refused, in the same order and with the same
// filters as listAuditEntries.
export async function listRefusedRequests(
  db: ImpDatabase,
  impId: string | null,
  limit: number,
  patterns: readonly string[] | null,
): Promise<RefusedRequest[]> {
  const rows = await listAuditRows(db, { impId, limit, patterns, refused: true });

  return rows.map((row) => {
    if (row.reason === null) {
      throw new Error(`broker audit row ${String(row.id)} was refused but has no reason`);
    }

    return {
      at: new Date(row.at),
      imp: row.name,
      method: row.method,
      host: row.host,
      path: row.path,
      status: row.status,
      durationMs: row.duration_ms,
      reason: row.reason,
    };
  });
}

interface AuditRowFilter {
  readonly impId: string | null;
  readonly limit: number;
  readonly patterns: readonly string[] | null;
  readonly refused: boolean;
}

function listAuditRows(db: ImpDatabase, filter: Readonly<AuditRowFilter>) {
  const kind = filter.refused ? 'is not' : 'is';

  const base = db
    .selectFrom('broker_audit')
    .innerJoin('imps', 'imps.id', 'broker_audit.imp_id')
    .select([
      'imps.name',
      'broker_audit.id',
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
    .where('broker_audit.reason', kind, null)
    .orderBy('broker_audit.id', 'desc')
    .limit(filter.limit);

  const named = filter.impId === null ? base : base.where('broker_audit.imp_id', '=', filter.impId);
  const patterns = filter.patterns;

  return (
    patterns === null
      ? named
      : named.where((eb) =>
          eb.or(patterns.map((pattern) => eb('imps.name', 'like', toLikePattern(pattern)))),
        )
  ).execute();
}
