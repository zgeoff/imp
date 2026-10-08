import { expect, test } from 'bun:test';
import { checkpointCollection } from './checkpoint-collection';
import { imageCollection } from './image-collection';
import { impCollection } from './imp-collection';
import { resetMockDb } from './reset-mock-db';
import { sessionCollection } from './session-collection';
import { systemInfoCollection } from './system-info-collection';
import { tokenCollection } from './token-collection';

test('it empties every collection', async () => {
  await impCollection.create({});
  await checkpointCollection.create({});
  await imageCollection.create({});
  await tokenCollection.create({});
  await sessionCollection.create({});
  await systemInfoCollection.create({});

  resetMockDb();

  expect(
    [
      impCollection,
      checkpointCollection,
      imageCollection,
      tokenCollection,
      sessionCollection,
      systemInfoCollection,
    ].map((collection) => collection.count()),
  ).toStrictEqual([0, 0, 0, 0, 0, 0]);
});
