import { expect, test } from 'bun:test';
import { createImage, listImages } from '../db/images';
import { listImps } from '../db/imps';
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

  await createImage(first.db, {
    name: 'dev',
    ref: 'imp/dev:latest',
    digest: 'sha256:1111',
    sizeBytes: 2048,
  });

  const images = await listImages(second.db);

  expect(images).toStrictEqual([]);
});

test('it closes the database on release', async () => {
  const testDatabase = await createTestDatabase();

  await testDatabase[Symbol.asyncDispose]();

  expect(listImages(testDatabase.db)).rejects.toThrow();
});

test('it resolves a second release as a no-op', async () => {
  const testDatabase = await createTestDatabase();

  await testDatabase[Symbol.asyncDispose]();

  await expect(testDatabase[Symbol.asyncDispose]()).toResolve();
});
