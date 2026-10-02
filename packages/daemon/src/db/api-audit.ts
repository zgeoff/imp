import type { ApiActor, ApiCall } from '@imp/api';
import type { Selectable } from 'kysely';
import { toLikePattern } from '../auth/imp-patterns';
import type { ImpDatabase } from './open-database';
import type { ApiAuditTable } from './schema';

// rows the API audit log keeps across every imp; older ones go as new ones come
export const API_AUDIT_ROWS = 10_000;

export interface NewApiCall {
  readonly at: Date;
  readonly procedure: string;
  readonly actor: ApiActor;
  readonly actorName: string;
  readonly impName: string | null;
  readonly outcome: string;
  readonly durationMs: number;
}

// One insert, then the rows past the cap by id: ids only grow, so the cut is
// one indexed delete, not a count.
export async function writeApiCall(db: ImpDatabase, call: NewApiCall): Promise<void> {
  const row = await db
    .insertInto('api_audit')
    .values({
      at: call.at.getTime(),
      procedure: call.procedure,
      actor: call.actor,
      actor_name: call.actorName,
      imp_name: call.impName,
      outcome: call.outcome,
      duration_ms: call.durationMs,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  if (row.id > API_AUDIT_ROWS) {
    await db
      .deleteFrom('api_audit')
      .where('id', '<=', row.id - API_AUDIT_ROWS)
      .execute();
  }
}

// newest first; the calls that named one imp when impName is set, and only
// those that named an imp within the patterns when there are any
export async function listApiCalls(
  db: ImpDatabase,
  impName: string | null,
  limit: number,
  patterns: readonly string[] | null,
): Promise<ApiCall[]> {
  const base = db.selectFrom('api_audit').selectAll().orderBy('id', 'desc').limit(limit);
  const named = impName === null ? base : base.where('imp_name', '=', impName);

  const rows = await (
    patterns === null
      ? named
      : named.where((eb) =>
          eb.or(patterns.map((pattern) => eb('imp_name', 'like', toLikePattern(pattern)))),
        )
  ).execute();

  return rows.map((row) => toApiCall(row));
}

function toApiCall(row: Readonly<Selectable<ApiAuditTable>>): ApiCall {
  const call: ApiCall = {
    at: new Date(row.at),
    procedure: row.procedure,
    actor: row.actor,
    outcome: row.outcome,
    durationMs: row.duration_ms,
  };

  if (row.actor_name !== null) {
    call.actorName = row.actor_name;
  }

  if (row.imp_name !== null) {
    call.imp = row.imp_name;
  }

  return call;
}
