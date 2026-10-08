import { onTestFinished } from 'bun:test';
import { openDatabase } from '../db/open-database';
import type { ImpDatabase } from '../db/open-database';

interface TestDatabase {
  readonly db: ImpDatabase;

  // transitional: in-flight area branches still hold this with `await using`;
  // a later GEO-135 PR removes it
  [Symbol.asyncDispose]: () => Promise<void>;
}

// a migrated in-memory database, empty, closed once when the test finishes
export async function createTestDatabase(): Promise<TestDatabase> {
  const db = await openDatabase(':memory:');

  const destroyed = { promise: null as Promise<void> | null };

  const destroy = (): Promise<void> => {
    destroyed.promise ??= db.destroy();

    return destroyed.promise;
  };

  onTestFinished(destroy);

  return { db, [Symbol.asyncDispose]: destroy };
}
