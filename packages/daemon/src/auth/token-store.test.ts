import { expect, test } from 'bun:test';
import { setupTestDatabase } from '../db/test-database';
import { ROOT_TOKEN_ID, loadTokenStore, readBearer } from './token-store';

const NOW = 1_800_000_000_000;

async function setupTest() {
  const database = await setupTestDatabase();

  const removed: string[] = [];

  const load = () =>
    loadTokenStore({
      db: database.db,
      rootToken: 'root-secret',
      now: () => NOW,
      onRemove: (id) => {
        removed.push(id);
      },
    });

  return { ...database, removed, load, tokens: await load() };
}

test('the root token stays valid as root, with every scope', async () => {
  await using ctx = await setupTest();

  expect(ctx.tokens.authenticate('root-secret')).toMatchObject({
    name: 'root',
    scope: 'manage',
    imps: null,
    tokenId: ROOT_TOKEN_ID,
  });

  expect(ctx.tokens.findById(ROOT_TOKEN_ID)?.name).toBe('root');
  expect(ctx.tokens.list()).toEqual([]);
});

test('a made token is stored hashed, survives a restart and authenticates', async () => {
  await using ctx = await setupTest();

  const made = await ctx.tokens.create({ name: 'ci', scope: 'exec', imps: ['dev-*'] });

  const secretPart = made.secret.split('.')[1] ?? '';

  const rows = await ctx.db.selectFrom('tokens').selectAll().execute();

  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(secretPart);
  expect(rows[0]?.secret_hash).toMatch(/^[0-9a-f]{64}$/);

  const restarted = await ctx.load();

  expect(restarted.authenticate(made.secret)).toMatchObject({
    kind: 'token',
    name: 'ci',
    scope: 'exec',
    imps: ['dev-*'],
  });

  expect(restarted.list()).toEqual([
    { name: 'ci', scope: 'exec', imps: ['dev-*'], createdAt: new Date(NOW) },
  ]);
});

test('a wrong secret, a wrong id or a bent format authenticates nothing', async () => {
  await using ctx = await setupTest();

  const made = await ctx.tokens.create({ name: 'ci', scope: 'read', imps: null });

  const [id = '', secret = ''] = made.secret.slice('imp_'.length).split('.');
  const flipped = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;

  for (const given of [
    `imp_${id}.${flipped}`,
    `imp_${id}.`,
    `imp_${id}.${secret}.extra`,
    `imp_nosuchid0000000.${secret}`,
    `imp_${id}${secret}`,
    '',
    'root-secret ',
    'root-secre',
  ]) {
    expect(ctx.tokens.authenticate(given)).toBeNull();
  }
});

test('a removed token authenticates nothing and its id is reported', async () => {
  await using ctx = await setupTest();

  const made = await ctx.tokens.create({ name: 'ci', scope: 'read', imps: null });

  const tokenId = ctx.tokens.authenticate(made.secret)?.tokenId ?? '';

  await ctx.tokens.remove('ci');

  expect(ctx.tokens.authenticate(made.secret)).toBeNull();
  expect(ctx.tokens.findById(tokenId)).toBeNull();
  expect(ctx.removed).toEqual([tokenId]);

  const missing = await ctx.tokens.remove('ci').catch((error: unknown) => error);

  expect(missing).toMatchObject({ code: 'NOT_FOUND' });
});

test('a bearer header gives its secret', () => {
  expect(readBearer('Bearer abc')).toBe('abc');
  expect(readBearer('Basic abc')).toBeNull();
  expect(readBearer(null)).toBeNull();
});
