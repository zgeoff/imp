import { createImage } from './images';
import type { ImageRecord } from './images';
import { openDatabase } from './open-database';
import type { ImpDatabase } from './open-database';

interface TestDatabase {
  readonly db: ImpDatabase;
  readonly image: ImageRecord;
  [Symbol.asyncDispose]: () => Promise<void>;
}

// a migrated in-memory database holding one image
export async function setupTestDatabase(): Promise<TestDatabase> {
  const db = await openDatabase(':memory:');

  const image = await createImage(db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  return {
    db,
    image,
    [Symbol.asyncDispose]: () => db.destroy(),
  };
}

// the message the promise rejects with; throws when it resolves instead
export async function readRejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('expected the promise to reject');
}
