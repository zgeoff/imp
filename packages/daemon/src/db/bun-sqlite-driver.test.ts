import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { CompiledQuery } from 'kysely';
import { BunSqliteDriver } from './bun-sqlite-driver';

function setupTest() {
  const sqlite = new Database(':memory:');

  onTestFinished(() => {
    sqlite.close();
  });

  return { sqlite, driver: new BunSqliteDriver(sqlite) };
}

test('it holds a second acquireConnection while the first is held', async () => {
  const ctx = setupTest();

  await ctx.driver.acquireConnection();

  const second = ctx.driver.acquireConnection();

  // two microtask drains: enough for the waiting acquire to resume if
  // nothing held the connection
  await Promise.resolve();
  await Promise.resolve();

  expect(Bun.peek.status(second)).toBe('pending');
});

test('it lets a second acquireConnection through after the first releaseConnection', async () => {
  const ctx = setupTest();

  await ctx.driver.acquireConnection();

  const second = ctx.driver.acquireConnection();

  await ctx.driver.releaseConnection();

  await expect(second).toResolve();
});

test('it closes the handle on destroy only after the held connection is released', async () => {
  const ctx = setupTest();

  const connection = await ctx.driver.acquireConnection();

  const destroyed = ctx.driver.destroy();

  await Promise.resolve();

  // still open: the holder can finish its write
  await connection.executeQuery(CompiledQuery.raw('select 1 as one'));
  await ctx.driver.releaseConnection();

  await destroyed;

  expect(() => connection.executeQuery(CompiledQuery.raw('select 1 as one'))).toThrow();
});

test('it keeps the writes of a committed transaction', async () => {
  const ctx = setupTest();

  ctx.sqlite.run('CREATE TABLE notes (title TEXT)');

  const connection = await ctx.driver.acquireConnection();

  await ctx.driver.beginTransaction(connection);
  await connection.executeQuery(CompiledQuery.raw("INSERT INTO notes VALUES ('kept')"));
  await ctx.driver.commitTransaction(connection);

  expect(ctx.sqlite.query('SELECT title FROM notes').all()).toStrictEqual([{ title: 'kept' }]);
});

test('it drops the writes of a rolled-back transaction', async () => {
  const ctx = setupTest();

  ctx.sqlite.run('CREATE TABLE notes (title TEXT)');

  const connection = await ctx.driver.acquireConnection();

  await ctx.driver.beginTransaction(connection);
  await connection.executeQuery(CompiledQuery.raw("INSERT INTO notes VALUES ('dropped')"));
  await ctx.driver.rollbackTransaction(connection);

  expect(ctx.sqlite.query('SELECT title FROM notes').all()).toStrictEqual([]);
});

test('it reports changed rows and the last insert id for a write', async () => {
  const ctx = setupTest();

  ctx.sqlite.run('CREATE TABLE notes (title TEXT)');

  const connection = await ctx.driver.acquireConnection();

  const result = await connection.executeQuery(
    CompiledQuery.raw('INSERT INTO notes VALUES (?), (?)', ['a', 'b']),
  );

  expect(result).toStrictEqual({ rows: [], numAffectedRows: 2n, insertId: 2n });
});

test('it refuses a streaming query', async () => {
  const ctx = setupTest();

  const connection = await ctx.driver.acquireConnection();

  expect(() => connection.streamQuery(CompiledQuery.raw('select 1'), 1)).toThrowWithMessage(
    Error,
    'BunSqliteDriver does not support streaming queries',
  );
});
