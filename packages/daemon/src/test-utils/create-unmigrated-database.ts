import { Database } from 'bun:sqlite';
import { onTestFinished } from 'bun:test';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import { BunSqliteDriver } from '../db/bun-sqlite-driver';
import type { ImpDatabase } from '../db/open-database';
import type { DatabaseSchema } from '../db/schema';

// A database opened as openDatabase opens one, with no migration run: a
// test migrates it to the point an older impd left it at. `:memory:` when
// no path is given; closed when the test finishes.
export function createUnmigratedDatabase(path = ':memory:'): ImpDatabase {
  const sqlite = new Database(path, { create: true });

  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA foreign_keys = ON;');

  const db = new Kysely<DatabaseSchema>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new BunSqliteDriver(sqlite),
      createIntrospector: (kysely) => new SqliteIntrospector(kysely),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });

  // kysely closes a driver only once a query started it, so the handle closes
  // here too
  onTestFinished(async () => {
    await db.destroy();

    sqlite.close();
  });

  return db;
}
