import { Database } from 'bun:sqlite';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import { BunSqliteDriver } from './bun-sqlite-driver';
import { runMigrations } from './run-migrations';
import type { DB } from './schema';

export type ImpDatabase = Kysely<DB>;

// `:memory:` gives a private in-memory database, which the tests use.
// `destroy()` on the result closes the file.
export async function openDatabase(path: string): Promise<ImpDatabase> {
  const sqlite = new Database(path, { create: true });

  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA foreign_keys = ON;');

  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new BunSqliteDriver(sqlite),
      createIntrospector: (kysely) => new SqliteIntrospector(kysely),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });

  // a database from a newer impd, or a migration that fails, leaves no
  // handle open
  try {
    await runMigrations(db);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  return db;
}
