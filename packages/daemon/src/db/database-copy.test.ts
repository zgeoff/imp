import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from 'kysely';
import { BunSqliteDriver } from './bun-sqlite-driver';
import { writeConsistentCopy, writeDatabaseCopy } from './database-copy';
import { openDatabase } from './open-database';
import { MIGRATIONS, runMigrationsTo } from './run-migrations';
import type { DatabaseSchema } from './schema';

const MIGRATION_NAMES = Object.keys(MIGRATIONS).toSorted();

function setupDataDir() {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-db-copy-`);

  return {
    dataDir,
    [Symbol.dispose]: () => {
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// a database migrated only up to `name`, as an older impd left it, and its
// copy at `copyPath`, as `imp db copy` of that impd wrote it
async function writeOlderCopy(path: string, name: string, copyPath: string): Promise<void> {
  const sqlite = new Database(path, { create: true });

  sqlite.run('PRAGMA journal_mode = WAL;');

  const db = new Kysely<DatabaseSchema>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new BunSqliteDriver(sqlite),
      createIntrospector: (kysely) => new SqliteIntrospector(kysely),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });

  try {
    await runMigrationsTo(db, name);
    await writeConsistentCopy(db, copyPath);
  } finally {
    await db.destroy();
  }
}

function readMigrationNames(path: string): string[] {
  const opened = new Database(path, { readonly: true });

  try {
    return opened
      .query<{ name: string }, []>('SELECT name FROM kysely_migration ORDER BY name')
      .all()
      .map((row) => row.name);
  } finally {
    opened.close();
  }
}

test('a copy taken while writes run is whole, and holds a prefix of them', async () => {
  using dir = setupDataDir();

  const db = await openDatabase(join(dir.dataDir, 'imp.sqlite'));

  try {
    const writes = Array.from({ length: 200 }, (_, index) =>
      sql`INSERT INTO api_audit (at, procedure, actor, outcome, duration_ms)
        VALUES (${index}, 'test.write', 'token', 'ok', 0)`.execute(db),
    );

    const [copy] = await Promise.all([
      writeDatabaseCopy(db, dir.dataDir, 'busy', Date.now),
      ...writes,
    ]);

    const opened = new Database(copy.path, { readonly: true });

    try {
      const check = opened.query('PRAGMA integrity_check').get();
      const count = opened.query<{ n: number }, []>('SELECT count(*) AS n FROM api_audit').get()?.n;

      expect(check).toEqual({ integrity_check: 'ok' });
      expect(count).toBeGreaterThanOrEqual(0);
      expect(count).toBeLessThanOrEqual(200);
    } finally {
      opened.close();
    }
  } finally {
    await db.destroy();
  }
});

test('an older copy, restored under this impd, migrates forward on open', async () => {
  using dir = setupDataDir();

  const older = join(dir.dataDir, 'older.sqlite');
  const restored = join(dir.dataDir, 'restored.sqlite');
  const at = MIGRATION_NAMES.at(-5) ?? '';

  await writeOlderCopy(older, at, restored);

  expect(readMigrationNames(restored).at(-1)).toBe(at);

  const db = await openDatabase(restored);

  await db.destroy();

  expect(readMigrationNames(restored)).toEqual(MIGRATION_NAMES);
});

test('a copy from a newer impd is refused at start, naming both schema versions', async () => {
  using dir = setupDataDir();

  const path = join(dir.dataDir, 'newer.sqlite');

  const db = await openDatabase(path);

  await sql`INSERT INTO kysely_migration (name, timestamp)
    VALUES ('999_from_a_newer_impd', '2030-01-01T00:00:00.000Z')`.execute(db);

  await db.destroy();

  const refused = await openDatabase(path).catch((error: unknown) => error);

  expect(String(refused)).toContain(
    `the database is at migration 999_from_a_newer_impd, newer than this impd's last, ${MIGRATION_NAMES.at(-1) ?? ''}`,
  );

  // nothing ran: the database is as the newer impd left it
  expect(readMigrationNames(path).at(-1)).toBe('999_from_a_newer_impd');
});

test('the shared copy step writes into an empty file that exists', async () => {
  using dir = setupDataDir();

  const db = await openDatabase(':memory:');

  try {
    const path = join(dir.dataDir, 'empty.sqlite');

    await Bun.write(path, '');

    await writeConsistentCopy(db, path);

    expect(readMigrationNames(path)).toEqual(MIGRATION_NAMES);
  } finally {
    await db.destroy();
  }
});
