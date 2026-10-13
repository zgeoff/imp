import { expect, test } from 'bun:test';
import { createTestDatabase } from './create-test-database';
import { runSql } from './run-sql';

async function setupTest() {
  const database = await createTestDatabase();

  return { db: database.db };
}

test('it binds each parameter to its placeholder', async () => {
  const ctx = await setupTest();

  await runSql(ctx.db, 'INSERT INTO networks (id, name, created_at) VALUES (?, ?, ?)', [
    'net-1',
    'lab',
    1000,
  ]);

  const rows = await runSql(ctx.db, 'SELECT id, name, created_at FROM networks');

  expect(rows).toStrictEqual([{ id: 'net-1', name: 'lab', created_at: 1000 }]);
});

test('it rejects with the database’s error for a statement that fails', async () => {
  const ctx = await setupTest();

  expect(runSql(ctx.db, 'SELECT * FROM no_such_table')).rejects.toThrowWithMessage(
    Error,
    'no such table: no_such_table',
  );
});
