import { createImage } from '../db/images';
import type { ImageRecord } from '../db/images';
import { openDatabase } from '../db/open-database';
import type { ImpDatabase } from '../db/open-database';

interface TestDatabase {
  readonly db: ImpDatabase;
  readonly image: ImageRecord;
  [Symbol.asyncDispose]: () => Promise<void>;
}

// a migrated in-memory database holding one image
export async function createTestDatabase(): Promise<TestDatabase> {
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
