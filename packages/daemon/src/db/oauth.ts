import type { Scope } from '@imp/api';
import type { Selectable } from 'kysely';
import * as z from 'zod';
import type { ImpDatabase } from './open-database';
import type { OAuthClientsTable, OAuthGrantsTable } from './schema';

// The public MCP route's OAuth rows (docs/guides/mcp.md#public-route)

export interface OAuthClientRecord {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly createdAt: Date;
}

export interface OAuthGrantRecord {
  readonly id: string;
  readonly clientId: string;
  readonly tokenId: string;
  readonly scope: Scope;
  readonly imps: readonly string[] | null;
  readonly resource: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

interface OAuthTokenRow {
  readonly id: string;
  readonly hash: string;
  readonly expiresAt: number;
}

// an access token with the grant it acts for and its client's name
export interface AccessTokenRecord {
  readonly hash: string;
  readonly expiresAt: number;
  readonly grant: OAuthGrantRecord;
  readonly clientName: string;
}

// a refresh token as a refresh reads it
export interface RefreshTokenRecord {
  readonly hash: string;
  readonly expiresAt: number;
  readonly spentAt: number | null;
  readonly grant: OAuthGrantRecord;
}

// what a refresh hands out in place of the token it spends
export interface IssuedTokens {
  readonly access: OAuthTokenRow;
  readonly refresh: OAuthTokenRow;
}

const UrisSchema = z.array(z.string());
const ImpsSchema = z.array(z.string()).nullable();

export async function listOAuthClients(db: ImpDatabase): Promise<OAuthClientRecord[]> {
  const rows = await db.selectFrom('oauth_clients').selectAll().orderBy('name').execute();

  return rows.map((row) => toClientRecord(row));
}

export async function findOAuthClientById(
  db: ImpDatabase,
  id: string,
): Promise<OAuthClientRecord | undefined> {
  const row = await db
    .selectFrom('oauth_clients')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();

  return row === undefined ? undefined : toClientRecord(row);
}

export async function findOAuthClientByName(
  db: ImpDatabase,
  name: string,
): Promise<OAuthClientRecord | undefined> {
  const row = await db
    .selectFrom('oauth_clients')
    .selectAll()
    .where('name', '=', name)
    .executeTakeFirst();

  return row === undefined ? undefined : toClientRecord(row);
}

export async function writeOAuthClient(
  db: ImpDatabase,
  client: Readonly<OAuthClientRecord>,
): Promise<void> {
  await db
    .insertInto('oauth_clients')
    .values({
      id: client.id,
      name: client.name,
      redirect_uris: JSON.stringify(client.redirectUris),
      created_at: client.createdAt.getTime(),
    })
    .execute();
}

export async function updateOAuthClientUris(
  db: ImpDatabase,
  id: string,
  redirectUris: readonly string[],
): Promise<void> {
  await db
    .updateTable('oauth_clients')
    .set({ redirect_uris: JSON.stringify(redirectUris) })
    .where('id', '=', id)
    .execute();
}

// the client, its grants and their tokens; returns the grants' ids
export function removeOAuthClient(db: ImpDatabase, id: string): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    const grants = await trx
      .selectFrom('oauth_grants')
      .select('id')
      .where('client_id', '=', id)
      .execute();

    const ids = grants.map((grant) => grant.id);

    if (ids.length > 0) {
      await trx.deleteFrom('oauth_tokens').where('grant_id', 'in', ids).execute();
      await trx.deleteFrom('oauth_grants').where('id', 'in', ids).execute();
    }

    await trx.deleteFrom('oauth_clients').where('id', '=', id).execute();

    return ids;
  });
}

export async function listOAuthGrants(db: ImpDatabase): Promise<OAuthGrantRecord[]> {
  const rows = await db.selectFrom('oauth_grants').selectAll().orderBy('created_at').execute();

  return rows.map((row) => toGrantRecord(row));
}

// the grant and its first tokens, together or not at all
export async function writeOAuthGrant(
  db: ImpDatabase,
  grant: Readonly<OAuthGrantRecord>,
  tokens: Readonly<IssuedTokens>,
  now: number,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('oauth_grants')
      .values({
        id: grant.id,
        client_id: grant.clientId,
        token_id: grant.tokenId,
        scope: grant.scope,
        imps: grant.imps === null ? null : JSON.stringify(grant.imps),
        resource: grant.resource,
        created_at: grant.createdAt.getTime(),
        last_used_at: null,
      })
      .execute();

    await writeTokens(trx, grant.id, tokens, now);
  });
}

// the grant and its tokens; false when it was gone already
export function removeOAuthGrant(db: ImpDatabase, id: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await trx.deleteFrom('oauth_tokens').where('grant_id', '=', id).execute();

    const result = await trx.deleteFrom('oauth_grants').where('id', '=', id).executeTakeFirst();

    return result.numDeletedRows > 0n;
  });
}

export async function findAccessToken(
  db: ImpDatabase,
  id: string,
): Promise<AccessTokenRecord | undefined> {
  const row = await db
    .selectFrom('oauth_tokens')
    .innerJoin('oauth_grants', 'oauth_grants.id', 'oauth_tokens.grant_id')
    .innerJoin('oauth_clients', 'oauth_clients.id', 'oauth_grants.client_id')
    .selectAll('oauth_grants')
    .select([
      'oauth_tokens.secret_hash as token_hash',
      'oauth_tokens.expires_at as token_expires_at',
      'oauth_clients.name as client_name',
    ])
    .where('oauth_tokens.id', '=', id)
    .where('oauth_tokens.kind', '=', 'access')
    .executeTakeFirst();

  if (row === undefined) {
    return undefined;
  }

  return {
    hash: row.token_hash,
    expiresAt: row.token_expires_at,
    grant: toGrantRecord(row),
    clientName: row.client_name,
  };
}

export async function findRefreshToken(
  db: ImpDatabase,
  id: string,
): Promise<RefreshTokenRecord | undefined> {
  const row = await db
    .selectFrom('oauth_tokens')
    .innerJoin('oauth_grants', 'oauth_grants.id', 'oauth_tokens.grant_id')
    .selectAll('oauth_grants')
    .select([
      'oauth_tokens.secret_hash as token_hash',
      'oauth_tokens.expires_at as token_expires_at',
      'oauth_tokens.spent_at as token_spent_at',
    ])
    .where('oauth_tokens.id', '=', id)
    .where('oauth_tokens.kind', '=', 'refresh')
    .executeTakeFirst();

  if (row === undefined) {
    return undefined;
  }

  return {
    hash: row.token_hash,
    expiresAt: row.token_expires_at,
    spentAt: row.token_spent_at,
    grant: toGrantRecord(row),
  };
}

// Spends the refresh token and issues its successors in one transaction:
// the conditional update lets exactly one of two racing refreshes win.
// False when the token was spent already, or is gone.
export function claimRefreshToken(
  db: ImpDatabase,
  id: string,
  grantId: string,
  tokens: Readonly<IssuedTokens>,
  now: number,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const spent = await trx
      .updateTable('oauth_tokens')
      .set({ spent_at: now })
      .where('id', '=', id)
      .where('kind', '=', 'refresh')
      .where('spent_at', 'is', null)
      .executeTakeFirst();

    if (spent.numUpdatedRows === 0n) {
      return false;
    }

    await writeTokens(trx, grantId, tokens, now);

    await trx
      .updateTable('oauth_grants')
      .set({ last_used_at: now })
      .where('id', '=', grantId)
      .execute();

    return true;
  });
}

export async function updateOAuthGrantUse(db: ImpDatabase, id: string, now: number): Promise<void> {
  await db.updateTable('oauth_grants').set({ last_used_at: now }).where('id', '=', id).execute();
}

// Drops expired tokens, then every grant left with no live refresh token:
// 30 days with no refresh ends a grant. Returns the grants it dropped.
export function removeExpiredOAuthRows(db: ImpDatabase, now: number): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    await trx.deleteFrom('oauth_tokens').where('expires_at', '<=', now).execute();

    const lapsed = await trx
      .selectFrom('oauth_grants')
      .select('id')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('oauth_tokens')
              .select('oauth_tokens.id')
              .whereRef('oauth_tokens.grant_id', '=', 'oauth_grants.id')
              .where('oauth_tokens.kind', '=', 'refresh')
              .where('oauth_tokens.spent_at', 'is', null),
          ),
        ),
      )
      .execute();

    const ids = lapsed.map((grant) => grant.id);

    if (ids.length > 0) {
      await trx.deleteFrom('oauth_tokens').where('grant_id', 'in', ids).execute();
      await trx.deleteFrom('oauth_grants').where('id', 'in', ids).execute();
    }

    return ids;
  });
}

async function writeTokens(
  trx: Pick<ImpDatabase, 'insertInto'>,
  grantId: string,
  tokens: Readonly<IssuedTokens>,
  now: number,
): Promise<void> {
  await trx
    .insertInto('oauth_tokens')
    .values([
      {
        id: tokens.access.id,
        grant_id: grantId,
        kind: 'access',
        secret_hash: tokens.access.hash,
        created_at: now,
        expires_at: tokens.access.expiresAt,
        spent_at: null,
      },
      {
        id: tokens.refresh.id,
        grant_id: grantId,
        kind: 'refresh',
        secret_hash: tokens.refresh.hash,
        created_at: now,
        expires_at: tokens.refresh.expiresAt,
        spent_at: null,
      },
    ])
    .execute();
}

function toClientRecord(row: Readonly<Selectable<OAuthClientsTable>>): OAuthClientRecord {
  return {
    id: row.id,
    name: row.name,
    redirectUris: UrisSchema.parse(JSON.parse(row.redirect_uris)),
    createdAt: new Date(row.created_at),
  };
}

function toGrantRecord(row: Readonly<Selectable<OAuthGrantsTable>>): OAuthGrantRecord {
  const imps: unknown = row.imps === null ? null : JSON.parse(row.imps);

  return {
    id: row.id,
    clientId: row.client_id,
    tokenId: row.token_id,
    scope: row.scope,
    imps: ImpsSchema.parse(imps),
    resource: row.resource,
    createdAt: new Date(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at),
  };
}
