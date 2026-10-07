import { openDatabase } from '../db/open-database';
import type { ImpDatabase } from '../db/open-database';

interface TestDatabase {
  readonly db: ImpDatabase;
  [Symbol.asyncDispose]: () => Promise<void>;
}

// a migrated in-memory database, empty, closed on dispose
export async function createTestDatabase(): Promise<TestDatabase> {
  const db = await openDatabase(':memory:');

  return {
    db,
    [Symbol.asyncDispose]: () => db.destroy(),
  };
}
