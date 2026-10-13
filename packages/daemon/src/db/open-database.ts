import { Database } from 'bun:sqlite';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import { createEventBus } from '../events/event-bus';
import { BunSqliteDriver } from './bun-sqlite-driver';
import type { ImpWrite, ImpWriteFeed } from './imp-write-feed';
import { runMigrations } from './run-migrations';
import type { DB } from './schema';

// the query builder, and the feed its imp writes go out on
export type ImpDatabase = Kysely<DB> & { readonly writes: ImpWriteFeed };

// a database or an open transaction: what a query needs, with no feed
export type ImpQueries = Kysely<DB>;

interface OpenOptions {
  // a fresh feed when none is given
  readonly writes?: ImpWriteFeed;
}

// `:memory:` gives a private in-memory database, which the tests use.
// `destroy()` on the result closes the file.
export async function openDatabase(path: string, options: OpenOptions = {}): Promise<ImpDatabase> {
  const sqlite = new Database(path, { create: true });

  sqlite.run('PRAGMA journal_mode = WAL;');
  sqlite.run('PRAGMA foreign_keys = ON;');

  const builder = new Kysely<DB>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new BunSqliteDriver(sqlite),
      createIntrospector: (kysely) => new SqliteIntrospector(kysely),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });

  const db = Object.assign(builder, { writes: options.writes ?? createEventBus<ImpWrite>() });

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
