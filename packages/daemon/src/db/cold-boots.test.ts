import { expect, test } from 'bun:test';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import { createTestDatabase } from '../test-utils/create-test-database';
import { listColdBoots, writeColdBoot } from './cold-boots';
import { createImage } from './images';
import { createImp } from './imps';

// a migrated database
async function setupTest() {
  const database = await createTestDatabase();

  return { db: database.db };
}

test('it lists two boots of the same millisecond in the order they were written, newest first', async () => {
  const ctx = await setupTest();

  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const at = new Date('2026-10-02T12:00:00Z');

  await writeColdBoot(ctx.db, imp.id, { bootId: 'boot-b', cause: 'start', at });
  await writeColdBoot(ctx.db, imp.id, { bootId: 'boot-a', cause: 'watchdog', at });

  const boots = await listColdBoots(ctx.db, imp.id);

  expect(boots.map((boot) => boot.bootId)).toStrictEqual(['boot-a', 'boot-b']);
});
