import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { CompiledQuery } from 'kysely';
import type { DatabaseConnection, Driver, QueryResult } from 'kysely';

// SQLite has one connection, so a promise-chain mutex hands it to one caller
// at a time; every transaction relies on that ordering.
export class BunSqliteDriver implements Driver {
  private readonly sqlite: Database;

  private readonly connection: DatabaseConnection;

  private turn: Promise<void> = Promise.resolve();

  private releaseTurn: () => void = () => {};

  constructor(sqlite: Database) {
    this.sqlite = sqlite;
    this.connection = buildConnection(sqlite);
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    const previous = this.turn;
    let release: (() => void) | undefined;

    this.turn = new Promise((resolve) => {
      release = resolve;
    });

    await previous;

    if (release !== undefined) {
      this.releaseTurn = release;
    }

    return this.connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  releaseConnection(): Promise<void> {
    this.releaseTurn();

    return Promise.resolve();
  }

  // Waits out whatever turn is already queued before closing, so the handle
  // never closes out from under a write still in flight.
  async destroy(): Promise<void> {
    await this.acquireConnection();

    this.sqlite.close();

    await this.releaseConnection();
  }
}

function buildConnection(sqlite: Database): DatabaseConnection {
  return {
    executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
      const stmt = sqlite.query<R, SQLQueryBindings[]>(compiledQuery.sql);

      // oxlint-disable-next-line no-unsafe-type-assertion -- kysely's sqlite compiler only ever binds bun:sqlite-legal values here; this is the one point where it is trusted
      const bindings = compiledQuery.parameters as SQLQueryBindings[];

      if (stmt.columnNames.length > 0) {
        return Promise.resolve({ rows: stmt.all(...bindings) });
      }

      const result = stmt.run(...bindings);

      return Promise.resolve({
        rows: [],
        numAffectedRows: BigInt(result.changes),
        insertId: BigInt(result.lastInsertRowid),
      });
    },

    streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error('BunSqliteDriver does not support streaming queries');
    },
  };
}
