import { expect, test } from 'bun:test';
import { buildMockTokenRecord } from '../test-utils/build-mock-token-record';
import { createTestDatabase } from '../test-utils/create-test-database';
import { removeTokenRecord, writeTokenRecord } from './tokens';

async function setupTest() {
  const database = await createTestDatabase();

  return { db: database.db };
}

test('#removeTokenRecord removes the grants the token approved, with their tokens', async () => {
  const ctx = await setupTest();

  const token = buildMockTokenRecord();

  await writeTokenRecord(ctx.db, token, []);

  // a grant as better-auth writes one: its user, its client and a refresh token
  await ctx.db
    .insertInto('user')
    .values({
      id: 'grant-1',
      name: token.name,
      email: 'grant-1@approval.imp.invalid',
      emailVerified: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      tokenId: token.id,
      imps: null,
    })
    .execute();

  await ctx.db
    .insertInto('oauthClient')
    .values({ id: 'client-row', clientId: 'impc_conn', redirectUris: '[]' })
    .execute();

  await ctx.db
    .insertInto('oauthRefreshToken')
    .values({
      id: 'refresh-1',
      token: 'hashed-refresh',
      clientId: 'impc_conn',
      userId: 'grant-1',
      expiresAt: '2026-02-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      scopes: '["read"]',
    })
    .execute();

  const removed = await removeTokenRecord(ctx.db, token.id);
  const refreshTokens = await ctx.db.selectFrom('oauthRefreshToken').select('id').execute();

  expect(removed).toStrictEqual(['grant-1']);
  expect(refreshTokens).toStrictEqual([]);
});

test('#removeTokenRecord never removes another token’s grants', async () => {
  const ctx = await setupTest();

  const gone = buildMockTokenRecord();
  const kept = buildMockTokenRecord();

  await writeTokenRecord(ctx.db, gone, []);
  await writeTokenRecord(ctx.db, kept, []);

  await ctx.db
    .insertInto('user')
    .values([
      {
        id: 'gone-grant',
        name: gone.name,
        email: 'gone-grant@approval.imp.invalid',
        emailVerified: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        tokenId: gone.id,
        imps: null,
      },
      {
        id: 'kept-grant',
        name: kept.name,
        email: 'kept-grant@approval.imp.invalid',
        emailVerified: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        tokenId: kept.id,
        imps: '["dev-*"]',
      },
    ])
    .execute();

  await removeTokenRecord(ctx.db, gone.id);

  const grants = await ctx.db.selectFrom('user').select('id').execute();

  expect(grants).toStrictEqual([{ id: 'kept-grant' }]);
});
