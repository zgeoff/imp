import { expect, test } from 'bun:test';
import { createImage, listImages } from '../db/images';
import { listImps } from '../db/imps';
import { createTestDatabase } from './create-test-database';

test('it opens a migrated database that holds no rows', async () => {
  await using testDatabase = await createTestDatabase();

  const tables = {
    images: await listImages(testDatabase.db),
    imps: await listImps(testDatabase.db),
  };

  expect(tables).toStrictEqual({ images: [], imps: [] });
});

test('it opens a fresh database on each call', async () => {
  await using first = await createTestDatabase();
  await using second = await createTestDatabase();

  await createImage(first.db, {
    name: 'dev',
    ref: 'imp/dev:latest',
    digest: 'sha256:1111',
    sizeBytes: 2048,
  });

  const images = await listImages(second.db);

  expect(images).toStrictEqual([]);
});

test('it closes the database on dispose', async () => {
  const testDatabase = await createTestDatabase();

  await testDatabase[Symbol.asyncDispose]();

  expect(listImages(testDatabase.db)).rejects.toThrow();
});
