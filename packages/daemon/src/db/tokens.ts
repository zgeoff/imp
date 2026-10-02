import type { Scope } from '@imp/api';
import type { Selectable } from 'kysely';
import * as z from 'zod';
import type { ImpDatabase } from './open-database';
import type { TokenSshKeysTable, TokensTable } from './schema';

export interface TokenRecord {
  readonly id: string;
  readonly name: string;
  readonly secretHash: string;
  readonly scope: Scope;
  readonly imps: readonly string[] | null;
  readonly createdAt: Date;
}

// an SSH key bound to a token
export interface TokenSshKeyRecord {
  readonly id: string;
  readonly tokenId: string;
  readonly fingerprint: string;

  // `<type> <base64>`
  readonly publicKey: string;
  readonly comment: string;
  readonly createdAt: Date;
}

const ImpsSchema = z.array(z.string()).nullable();

export async function listTokenRecords(db: ImpDatabase): Promise<TokenRecord[]> {
  const rows = await db.selectFrom('tokens').selectAll().orderBy('name').execute();

  return rows.map((row) => toTokenRecord(row));
}

export async function listTokenSshKeyRecords(db: ImpDatabase): Promise<TokenSshKeyRecord[]> {
  const rows = await db.selectFrom('token_ssh_keys').selectAll().orderBy('created_at').execute();

  return rows.map((row) => toTokenSshKeyRecord(row));
}

// the token and its keys, together or not at all
export async function writeTokenRecord(
  db: ImpDatabase,
  token: Readonly<TokenRecord>,
  keys: readonly TokenSshKeyRecord[],
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
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

    for (const key of keys) {
      await writeSshKeyRow(trx, key);
    }
  });
}

// the token and its keys
export async function removeTokenRecord(db: ImpDatabase, id: string): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('token_ssh_keys').where('token_id', '=', id).execute();
    await trx.deleteFrom('tokens').where('id', '=', id).execute();
  });
}

export async function writeTokenSshKeyRecord(
  db: ImpDatabase,
  key: Readonly<TokenSshKeyRecord>,
): Promise<void> {
  await writeSshKeyRow(db, key);
}

export async function removeTokenSshKeyRecord(db: ImpDatabase, id: string): Promise<void> {
  await db.deleteFrom('token_ssh_keys').where('id', '=', id).execute();
}

async function writeSshKeyRow(
  db: Pick<ImpDatabase, 'insertInto'>,
  key: Readonly<TokenSshKeyRecord>,
): Promise<void> {
  await db
    .insertInto('token_ssh_keys')
    .values({
      id: key.id,
      token_id: key.tokenId,
      fingerprint: key.fingerprint,
      public_key: key.publicKey,
      comment: key.comment,
      created_at: key.createdAt.getTime(),
    })
    .execute();
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

function toTokenSshKeyRecord(row: Readonly<Selectable<TokenSshKeysTable>>): TokenSshKeyRecord {
  return {
    id: row.id,
    tokenId: row.token_id,
    fingerprint: row.fingerprint,
    publicKey: row.public_key,
    comment: row.comment,
    createdAt: new Date(row.created_at),
  };
}
