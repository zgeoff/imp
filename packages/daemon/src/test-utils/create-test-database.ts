import { onTestFinished } from 'bun:test';
import { openDatabase } from '../db/open-database';
import type { ImpDatabase } from '../db/open-database';

interface TestDatabase {
  readonly db: ImpDatabase;
}

// a migrated in-memory database, empty, closed when the test finishes
export async function createTestDatabase(): Promise<TestDatabase> {
  const db = await openDatabase(':memory:');

  onTestFinished(() => db.destroy());

  return { db };
}
