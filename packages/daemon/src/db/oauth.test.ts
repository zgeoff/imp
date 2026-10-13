import { expect, test } from 'bun:test';
import { buildMockOAuthClientRecord } from '../test-utils/build-mock-oauth-client-record';
import { buildMockOAuthGrantRecord } from '../test-utils/build-mock-oauth-grant-record';
import { buildMockTokenRecord } from '../test-utils/build-mock-token-record';
import { createTestDatabase } from '../test-utils/create-test-database';
import {
  removeExpiredOAuthRows,
  removeOAuthClient,
  removeOAuthGrant,
  writeOAuthClient,
  writeOAuthGrant,
} from './oauth';
import { writeTokenRecord } from './tokens';

async function setupTest() {
  const database = await createTestDatabase();

  return { db: database.db };
}

test('#removeOAuthClient removes the tokens of the client’s grants through the database cascade', async () => {
  const ctx = await setupTest();

  const token = buildMockTokenRecord();
  const client = buildMockOAuthClientRecord();
  const grant = buildMockOAuthGrantRecord({ clientId: client.id, tokenId: token.id });

  await writeTokenRecord(ctx.db, token, []);
  await writeOAuthClient(ctx.db, client);

  await writeOAuthGrant(
    ctx.db,
    grant,
    {
      access: { id: 'access-1', hash: 'ha', expiresAt: 2000 },
      refresh: { id: 'refresh-1', hash: 'hr', expiresAt: 3000 },
    },
    1000,
  );

  const removed = await removeOAuthClient(ctx.db, client.id);
  const tokens = await ctx.db.selectFrom('oauth_tokens').select('id').execute();

  expect(removed).toStrictEqual([grant.id]);
  expect(tokens).toStrictEqual([]);
});

test('#removeOAuthClient never removes another client’s tokens', async () => {
  const ctx = await setupTest();

  const token = buildMockTokenRecord();
  const gone = buildMockOAuthClientRecord();
  const kept = buildMockOAuthClientRecord();

  await writeTokenRecord(ctx.db, token, []);
  await writeOAuthClient(ctx.db, gone);
  await writeOAuthClient(ctx.db, kept);

  await writeOAuthGrant(
    ctx.db,
    buildMockOAuthGrantRecord({ clientId: gone.id, tokenId: token.id }),
    {
      access: { id: 'gone-access', hash: 'h1', expiresAt: 2000 },
      refresh: { id: 'gone-refresh', hash: 'h2', expiresAt: 3000 },
    },
    1000,
  );

  await writeOAuthGrant(
    ctx.db,
    buildMockOAuthGrantRecord({ clientId: kept.id, tokenId: token.id }),
    {
      access: { id: 'kept-access', hash: 'h3', expiresAt: 2000 },
      refresh: { id: 'kept-refresh', hash: 'h4', expiresAt: 3000 },
    },
    1000,
  );

  await removeOAuthClient(ctx.db, gone.id);

  const tokens = await ctx.db.selectFrom('oauth_tokens').select('id').orderBy('id').execute();

  expect(tokens).toStrictEqual([{ id: 'kept-access' }, { id: 'kept-refresh' }]);
});

test('#removeOAuthGrant removes the grant’s tokens through the database cascade', async () => {
  const ctx = await setupTest();

  const token = buildMockTokenRecord();
  const client = buildMockOAuthClientRecord();
  const grant = buildMockOAuthGrantRecord({ clientId: client.id, tokenId: token.id });

  await writeTokenRecord(ctx.db, token, []);
  await writeOAuthClient(ctx.db, client);

  await writeOAuthGrant(
    ctx.db,
    grant,
    {
      access: { id: 'access-1', hash: 'ha', expiresAt: 2000 },
      refresh: { id: 'refresh-1', hash: 'hr', expiresAt: 3000 },
    },
    1000,
  );

  const removed = await removeOAuthGrant(ctx.db, grant.id);
  const tokens = await ctx.db.selectFrom('oauth_tokens').select('id').execute();

  expect(removed).toBe(true);
  expect(tokens).toStrictEqual([]);
});

test('#removeOAuthGrant reports a grant that was gone already', async () => {
  const ctx = await setupTest();
  const removed = await removeOAuthGrant(ctx.db, 'missing');

  expect(removed).toBe(false);
});

test('#removeExpiredOAuthRows removes a lapsed grant with its unexpired access token', async () => {
  const ctx = await setupTest();

  const token = buildMockTokenRecord();
  const client = buildMockOAuthClientRecord();
  const grant = buildMockOAuthGrantRecord({ clientId: client.id, tokenId: token.id });

  await writeTokenRecord(ctx.db, token, []);
  await writeOAuthClient(ctx.db, client);

  // the refresh token expires first, so the grant lapses while its access
  // token still lives
  await writeOAuthGrant(
    ctx.db,
    grant,
    {
      access: { id: 'access-1', hash: 'ha', expiresAt: 5000 },
      refresh: { id: 'refresh-1', hash: 'hr', expiresAt: 2000 },
    },
    1000,
  );

  const removed = await removeExpiredOAuthRows(ctx.db, 3000);
  const tokens = await ctx.db.selectFrom('oauth_tokens').select('id').execute();

  expect(removed).toStrictEqual([grant.id]);
  expect(tokens).toStrictEqual([]);
});
