import { isImpAllowed } from '@imp/api';
import type { Scope } from '@imp/api';
import type { Selectable } from 'kysely';
import * as z from 'zod';
import type { ImpDatabase } from './open-database';
import type { TokenSshKeysTable, TokensTable } from './schema';

// a secret a token may grant: its name, and its generation when the token
// was made; a secret deleted and made again under the name is another one
export interface GrantableSecret {
  readonly name: string;
  readonly generation: string;
}

export interface TokenRecord {
  readonly id: string;
  readonly name: string;
  readonly secretHash: string;
  readonly scope: Scope;
  readonly imps: readonly string[] | null;
  readonly grantable: readonly GrantableSecret[];
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
const GrantableSchema = z.array(z.object({ name: z.string(), generation: z.string() }));

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
        grantable: JSON.stringify(token.grantable),
        created_at: token.createdAt.getTime(),
      })
      .execute();

    for (const key of keys) {
      await writeSshKeyRow(trx, key);
    }
  });
}

// A new grantable list, and the end of the grants of each secret left off
// on the token's imps, whoever made them, as a rebind drops them. Returns
// how many it dropped; null for no such token.
export function updateTokenGrantable(
  db: ImpDatabase,
  id: string,
  grantable: readonly GrantableSecret[],
): Promise<number | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('tokens')
      .select(['imps', 'grantable'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    await trx
      .updateTable('tokens')
      .set({ grantable: JSON.stringify(grantable) })
      .where('id', '=', id)
      .execute();

    const kept = new Set(grantable.map((secret) => secret.name));

    const removed = GrantableSchema.parse(JSON.parse(row.grantable))
      .map((secret) => secret.name)
      .filter((name) => !kept.has(name));

    const imps: unknown = row.imps === null ? null : JSON.parse(row.imps);
    const patterns = ImpsSchema.parse(imps);

    // a host-wide token holds no list, so it has nothing to drop
    if (removed.length === 0 || patterns === null) {
      return 0;
    }

    const rows = await trx.selectFrom('imps').select(['id', 'name']).execute();

    const impIds = rows.filter((imp) => isImpAllowed(patterns, imp.name)).map((imp) => imp.id);

    if (impIds.length === 0) {
      return 0;
    }

    const dropped = await trx
      .deleteFrom('grants')
      .where('secret_name', 'in', removed)
      .where('imp_id', 'in', impIds)
      .executeTakeFirst();

    return Number(dropped.numDeletedRows);
  });
}

// the token's grantable list as the database holds it now, read in the
// caller's transaction; null for no such token
export async function readTokenGrantable(
  db: ImpDatabase,
  id: string,
): Promise<GrantableSecret[] | null> {
  const row = await db
    .selectFrom('tokens')
    .select('grantable')
    .where('id', '=', id)
    .executeTakeFirst();

  return row === undefined ? null : GrantableSchema.parse(JSON.parse(row.grantable));
}

// the token, its keys, and the OAuth grants it approved with their tokens;
// returns the grants' ids, for their revocation
export function removeTokenRecord(db: ImpDatabase, id: string): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    await trx.deleteFrom('token_ssh_keys').where('token_id', '=', id).execute();

    const grants = await trx
      .selectFrom('oauth_grants')
      .select('id')
      .where('token_id', '=', id)
      .execute();

    const grantIds = grants.map((grant) => grant.id);

    if (grantIds.length > 0) {
      await trx.deleteFrom('oauth_tokens').where('grant_id', 'in', grantIds).execute();
      await trx.deleteFrom('oauth_grants').where('id', 'in', grantIds).execute();
    }

    await trx.deleteFrom('tokens').where('id', '=', id).execute();

    return grantIds;
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
    grantable: GrantableSchema.parse(JSON.parse(row.grantable)),
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
