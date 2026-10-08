import { expect, test } from 'bun:test';
import { Collection } from '@msw/data';
import * as db from './index';
import { resetMockDb } from './reset-mock-db';

test('it empties every collection the store exports', async () => {
  const collections = Object.values(db).filter((value) => value instanceof Collection);

  await Promise.all(collections.map((collection) => collection.create({})));

  const seeded = collections.map((collection) => collection.count());

  resetMockDb();

  const counts = collections.map((collection) => collection.count());

  expect(seeded).toSatisfyAll((count: number) => count === 1);
  expect(counts).toSatisfyAll((count: number) => count === 0);
});
