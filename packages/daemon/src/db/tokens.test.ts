import { expect, test } from 'bun:test';
import { buildMockOAuthClientRecord } from '../test-utils/build-mock-oauth-client-record';
import { buildMockOAuthGrantRecord } from '../test-utils/build-mock-oauth-grant-record';
import { buildMockTokenRecord } from '../test-utils/build-mock-token-record';
import { createTestDatabase } from '../test-utils/create-test-database';
import { writeOAuthClient, writeOAuthGrant } from './oauth';
import { removeTokenRecord, writeTokenRecord } from './tokens';

async function setupTest() {
  const database = await createTestDatabase();

  return { db: database.db };
}

test('#removeTokenRecord removes the tokens of the grants the token approved', async () => {
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

  const removed = await removeTokenRecord(ctx.db, token.id);
  const tokens = await ctx.db.selectFrom('oauth_tokens').select('id').execute();

  expect(removed).toStrictEqual([grant.id]);
  expect(tokens).toStrictEqual([]);
});

test('#removeTokenRecord never removes the OAuth tokens of another token’s grants', async () => {
  const ctx = await setupTest();

  const gone = buildMockTokenRecord();
  const kept = buildMockTokenRecord();
  const client = buildMockOAuthClientRecord();

  await writeTokenRecord(ctx.db, gone, []);
  await writeTokenRecord(ctx.db, kept, []);
  await writeOAuthClient(ctx.db, client);

  await writeOAuthGrant(
    ctx.db,
    buildMockOAuthGrantRecord({ clientId: client.id, tokenId: gone.id }),
    {
      access: { id: 'gone-access', hash: 'h1', expiresAt: 2000 },
      refresh: { id: 'gone-refresh', hash: 'h2', expiresAt: 3000 },
    },
    1000,
  );

  await writeOAuthGrant(
    ctx.db,
    buildMockOAuthGrantRecord({ clientId: client.id, tokenId: kept.id }),
    {
      access: { id: 'kept-access', hash: 'h3', expiresAt: 2000 },
      refresh: { id: 'kept-refresh', hash: 'h4', expiresAt: 3000 },
    },
    1000,
  );

  await removeTokenRecord(ctx.db, gone.id);

  const tokens = await ctx.db.selectFrom('oauth_tokens').select('id').orderBy('id').execute();

  expect(tokens).toStrictEqual([{ id: 'kept-access' }, { id: 'kept-refresh' }]);
});
