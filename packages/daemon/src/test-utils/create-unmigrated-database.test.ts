import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('it closes the database file when the test finishes, even one no query opened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-unmigrated-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  createUnmigratedDatabase(join(dir, 'older.sqlite'));

  // runs after the helper's own close, and after the dir's removal, which
  // leaves an open file listed as deleted: no descriptor names the file
  onTestFinished(() => {
    const descriptors = Bun.spawnSync(['ls', '-l', `/proc/${String(process.pid)}/fd`]);

    expect(descriptors.stdout.toString()).not.toInclude(join(dir, 'older.sqlite'));
  });
});
