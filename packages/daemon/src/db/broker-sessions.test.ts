import { expect, test } from 'bun:test';
import { buildMockNewImage } from '../test-utils/build-mock-new-image';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import { createTestDatabase } from '../test-utils/create-test-database';
import { isBrokerSession, writeBrokerSession } from './broker-sessions';
import { createImage } from './images';
import { createImp, removeImp } from './imps';

test('it keeps an earlier session that the agent still lists', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeBrokerSession(ctx.db, imp.id, 'gen-a', []);
  await writeBrokerSession(ctx.db, imp.id, 'gen-b', ['gen-a']);

  const isKept = await isBrokerSession(ctx.db, imp.id, 'gen-a');

  expect(isKept).toBeTrue();
});

test('it drops an earlier session that the agent no longer lists', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeBrokerSession(ctx.db, imp.id, 'gen-a', []);
  await writeBrokerSession(ctx.db, imp.id, 'gen-b', ['gen-a']);
  await writeBrokerSession(ctx.db, imp.id, 'gen-c', ['gen-b']);

  const isKept = await isBrokerSession(ctx.db, imp.id, 'gen-a');

  expect(isKept).toBeFalse();
});

test('it keeps the new session and the listed one', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeBrokerSession(ctx.db, imp.id, 'gen-a', []);
  await writeBrokerSession(ctx.db, imp.id, 'gen-b', ['gen-a']);
  await writeBrokerSession(ctx.db, imp.id, 'gen-c', ['gen-b']);

  const kept = await Promise.all([
    isBrokerSession(ctx.db, imp.id, 'gen-b'),
    isBrokerSession(ctx.db, imp.id, 'gen-c'),
  ]);

  expect(kept).toStrictEqual([true, true]);
});

test('it removes the sessions with their imp', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeBrokerSession(ctx.db, imp.id, 'gen-a', []);
  await removeImp(ctx.db, imp.id);

  const isKept = await isBrokerSession(ctx.db, imp.id, 'gen-a');

  expect(isKept).toBeFalse();
});
