import { onTestFinished } from 'bun:test';
import { openDatabase } from '../db/open-database';
import type { ImpDatabase } from '../db/open-database';

interface TestDatabase {
  readonly db: ImpDatabase;

  // transitional: in-flight area branches still hold this with `await using`;
  // a later GEO-135 PR removes it
  [Symbol.asyncDispose]: () => Promise<void>;
}

// a migrated in-memory database, empty, closed when the test finishes
export async function createTestDatabase(): Promise<TestDatabase> {
  const db = await openDatabase(':memory:');

  onTestFinished(() => db.destroy());

  return { db, [Symbol.asyncDispose]: () => db.destroy() };
}
