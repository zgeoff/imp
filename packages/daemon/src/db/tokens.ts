import type { Scope } from '@imp/api';
import type { Selectable } from 'kysely';
import * as z from 'zod';
import type { ImpDatabase } from './open-database';
import type { TokensTable } from './schema';

export interface TokenRecord {
  readonly id: string;
  readonly name: string;
  readonly secretHash: string;
  readonly scope: Scope;
  readonly imps: readonly string[] | null;
  readonly createdAt: Date;
}

const ImpsSchema = z.array(z.string()).nullable();

export async function listTokenRecords(db: ImpDatabase): Promise<TokenRecord[]> {
  const rows = await db.selectFrom('tokens').selectAll().orderBy('name').execute();

  return rows.map((row) => toTokenRecord(row));
}

export async function writeTokenRecord(
  db: ImpDatabase,
  token: Readonly<TokenRecord>,
): Promise<void> {
  await db
    .insertInto('tokens')
    .values({
      id: token.id,
      name: token.name,
      secret_hash: token.secretHash,
      scope: token.scope,
      imps: token.imps === null ? null : JSON.stringify(token.imps),
      created_at: token.createdAt.getTime(),
    })
    .execute();
}

export async function removeTokenRecord(db: ImpDatabase, id: string): Promise<void> {
  await db.deleteFrom('tokens').where('id', '=', id).execute();
}

function toTokenRecord(row: Readonly<Selectable<TokensTable>>): TokenRecord {
  const imps: unknown = row.imps === null ? null : JSON.parse(row.imps);

  return {
    id: row.id,
    name: row.name,
    secretHash: row.secret_hash,
    scope: row.scope,
    imps: ImpsSchema.parse(imps),
    createdAt: new Date(row.created_at),
  };
}
