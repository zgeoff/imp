import { expect, test } from 'bun:test';
import { isBrokerSession, writeBrokerSession } from './broker-sessions';
import { createImp, removeImp } from './imps';
import { setupTestDatabase } from './test-database';

test('a session run is kept while it runs, and goes with its imp', async () => {
  await using database = await setupTestDatabase();

  const db = database.db;

  const imp = await createImp(db, {
    name: 'dev',
    imageId: database.image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  await writeBrokerSession(db, imp.id, 'gen-a', []);
  await writeBrokerSession(db, imp.id, 'gen-b', ['gen-a']);

  const isFirstKept = await isBrokerSession(db, imp.id, 'gen-a');

  expect(isFirstKept).toBe(true);

  // gen-a no longer runs when gen-c starts
  await writeBrokerSession(db, imp.id, 'gen-c', ['gen-b']);

  const kept = await Promise.all(
    ['gen-a', 'gen-b', 'gen-c'].map((generation) => isBrokerSession(db, imp.id, generation)),
  );

  expect(kept).toEqual([false, true, true]);

  await removeImp(db, imp.id);

  const isGoneWithImp = !(await isBrokerSession(db, imp.id, 'gen-c'));

  expect(isGoneWithImp).toBe(true);
});
