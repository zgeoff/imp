import { expect, onTestFinished, test } from 'bun:test';
import { createImage, listImages } from '../db/images';
import { listImps } from '../db/imps';
import { buildMockNewImage } from './build-mock-new-image';
import { createTestDatabase } from './create-test-database';

test('it opens a migrated database that holds no images', async () => {
  const testDatabase = await createTestDatabase();

  expect(listImages(testDatabase.db)).resolves.toStrictEqual([]);
});

test('it opens a migrated database that holds no imps', async () => {
  const testDatabase = await createTestDatabase();

  expect(listImps(testDatabase.db)).resolves.toStrictEqual([]);
});

test('it opens a fresh database on each call', async () => {
  const first = await createTestDatabase();
  const second = await createTestDatabase();

  await createImage(first.db, buildMockNewImage({ name: 'dev' }));

  const images = await listImages(second.db);

  expect(images).toStrictEqual([]);
});

test('it closes the database when the test finishes', async () => {
  const testDatabase = await createTestDatabase();

  // runs after the helper's own close
  onTestFinished(() => {
    expect(listImages(testDatabase.db)).rejects.toThrow('driver has already been destroyed');
  });
});
