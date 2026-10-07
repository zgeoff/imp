import { expect, test } from 'bun:test';
import { createTestDatabase } from '../test-utils/create-test-database';
import { isBrokerSession, writeBrokerSession } from './broker-sessions';
import { createImage } from './images';
import { createImp, removeImp } from './imps';

test('a session run is kept while it runs, and goes with its imp', async () => {
  await using database = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(database.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const db = database.db;

  const imp = await createImp(db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  await writeBrokerSession(db, imp.id, 'gen-a', []);
  await writeBrokerSession(db, imp.id, 'gen-b', ['gen-a']);

  const isFirstKept = await isBrokerSession(db, imp.id, 'gen-a');

  expect(isFirstKept).toBe(true);

  // the agent no longer lists gen-a when gen-c starts
  await writeBrokerSession(db, imp.id, 'gen-c', ['gen-b']);

  const kept = await Promise.all(
    ['gen-a', 'gen-b', 'gen-c'].map((generation) => isBrokerSession(db, imp.id, generation)),
  );

  expect(kept).toEqual([false, true, true]);

  await removeImp(db, imp.id);

  const isGoneWithImp = !(await isBrokerSession(db, imp.id, 'gen-c'));

  expect(isGoneWithImp).toBe(true);
});
