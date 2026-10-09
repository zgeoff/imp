import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChildTests } from '@imp/test-utils/run-child-tests';
import { sql } from 'kysely';
import { createUnmigratedDatabase } from './create-unmigrated-database';

test('it opens a database with no tables', async () => {
  const db = createUnmigratedDatabase();

  const tables = await sql`SELECT name FROM sqlite_master WHERE type = 'table'`.execute(db);

  expect(tables.rows).toStrictEqual([]);
});

test('it enforces foreign keys, as openDatabase does', async () => {
  const db = createUnmigratedDatabase();

  const pragma = await sql`PRAGMA foreign_keys`.execute(db);

  expect(pragma.rows).toStrictEqual([{ foreign_keys: 1 }]);
});

test('it opens the file at the path it is given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-unmigrated-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  createUnmigratedDatabase(join(dir, 'older.sqlite'));

  expect(existsSync(join(dir, 'older.sqlite'))).toBeTrue();
});

test('it closes the database when the test finishes, even one no query opened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-unmigrated-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = runChildTests(
    dir,
    [
      "import { expect, test } from 'bun:test';",
      `import { createUnmigratedDatabase } from ${JSON.stringify(join(import.meta.dir, 'create-unmigrated-database.ts'))};`,
      'const left: { db: ReturnType<typeof createUnmigratedDatabase> | null } = { db: null };',
      "test('it opens', () => { left.db = createUnmigratedDatabase(); });",
      "test('it finds it closed', () => { expect(left.db!.selectNoFrom((eb) => eb.val(1).as('one')).execute()).rejects.toThrow(); });",
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 2 pass');
});
