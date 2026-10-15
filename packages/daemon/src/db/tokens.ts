import { isImpAllowed } from '@impz/api';
import type { Scope } from '@impz/api';
import type { Selectable } from 'kysely';
import * as z from 'zod';
import { ImpsSchema } from './imps-schema';
import type { ImpDatabase, ImpQueries } from './open-database';
import type { TokenSshKeys, Tokens } from './schema';

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

  // the start every image ref it adds must have; null when it adds none
  readonly imageRefPrefix: string | null;
  readonly createdAt: Date;
}

// what a tokens.update changes; a field left out stays as it is
export interface TokenChange {
  // builds the new grantable list in the write
  readonly readGrantable?: (trx: ImpQueries) => Promise<GrantableSecret[]>;
  readonly imageRefPrefix?: string | null;
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
        image_ref_prefix: token.imageRefPrefix,
        created_at: token.createdAt.getTime(),
      })
      .execute();

    for (const key of keys) {
      await writeSshKeyRow(trx, key);
    }
  });
}

// The change in one write, so a new list's generations are one snapshot; a
// secret left off loses its grants on the token's imps, whoever made them,
// as a rebind drops them. Null for no such token.
export function updateTokenRecord(
  db: ImpDatabase,
  id: string,
  change: Readonly<TokenChange>,
): Promise<{
  grantable: GrantableSecret[];
  imageRefPrefix: string | null;
  dropped: number;
} | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('tokens')
      .select(['imps', 'grantable', 'image_ref_prefix'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    const old = GrantableSchema.parse(JSON.parse(row.grantable));
    const grantable = change.readGrantable === undefined ? old : await change.readGrantable(trx);

    const imageRefPrefix =
      change.imageRefPrefix === undefined ? row.image_ref_prefix : change.imageRefPrefix;

    await trx
      .updateTable('tokens')
      .set({ grantable: JSON.stringify(grantable), image_ref_prefix: imageRefPrefix })
      .where('id', '=', id)
      .execute();

    const kept = new Set(grantable.map((secret) => secret.name));

    const removed = old.map((secret) => secret.name).filter((name) => !kept.has(name));
    const imps: unknown = row.imps === null ? null : JSON.parse(row.imps);
    const patterns = ImpsSchema.parse(imps);

    // a host-wide token holds no list, so it has nothing to drop
    if (removed.length === 0 || patterns === null) {
      return { grantable, imageRefPrefix, dropped: 0 };
    }

    const rows = await trx.selectFrom('imps').select(['id', 'name']).execute();

    const impIds = rows.filter((imp) => isImpAllowed(patterns, imp.name)).map((imp) => imp.id);

    if (impIds.length === 0) {
      return { grantable, imageRefPrefix, dropped: 0 };
    }

    const dropped = await trx
      .deleteFrom('grants')
      .where('secret_name', 'in', removed)
      .where('imp_id', 'in', impIds)
      .executeTakeFirst();

    return { grantable, imageRefPrefix, dropped: Number(dropped.numDeletedRows) };
  });
}

// the token's grantable list as the database holds it now, read in the
// caller's transaction; null for no such token
export async function readTokenGrantable(
  db: ImpQueries,
  id: string,
): Promise<GrantableSecret[] | null> {
  const row = await db
    .selectFrom('tokens')
    .select('grantable')
    .where('id', '=', id)
    .executeTakeFirst();

  return row === undefined ? null : GrantableSchema.parse(JSON.parse(row.grantable));
}

// the token, its keys, and the OAuth grants it approved, whose tokens go with
// them; returns the grants' ids, for their revocation
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

function toTokenRecord(row: Readonly<Selectable<Tokens>>): TokenRecord {
  const imps: unknown = row.imps === null ? null : JSON.parse(row.imps);

  return {
    id: row.id,
    name: row.name,
    secretHash: row.secret_hash,
    scope: row.scope,
    imps: ImpsSchema.parse(imps),
    grantable: GrantableSchema.parse(JSON.parse(row.grantable)),
    imageRefPrefix: row.image_ref_prefix,
    createdAt: new Date(row.created_at),
  };
}

function toTokenSshKeyRecord(row: Readonly<Selectable<TokenSshKeys>>): TokenSshKeyRecord {
  return {
    id: row.id,
    tokenId: row.token_id,
    fingerprint: row.fingerprint,
    publicKey: row.public_key,
    comment: row.comment,
    createdAt: new Date(row.created_at),
  };
}
