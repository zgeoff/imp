import { expect, test } from 'bun:test';
import { createImage, listImages } from '../db/images';
import { createTestDatabase } from './create-test-database';

test('it holds one image with the documented fields', async () => {
  await using testDatabase = await createTestDatabase();

  const images = await listImages(testDatabase.db);

  expect(images).toStrictEqual([
    {
      id: expect.toBeString(),
      name: 'base',
      ref: 'imp/base:latest',
      digest: 'sha256:0000',
      source: 'oci',
      sourceImp: null,
      sizeBytes: 1024,
      createdAt: expect.toBeValidDate(),
    },
  ]);
});

test('it returns the image row it wrote', async () => {
  await using testDatabase = await createTestDatabase();

  const images = await listImages(testDatabase.db);

  expect(images).toStrictEqual([testDatabase.image]);
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

  expect(images.map((image) => image.name)).toStrictEqual(['base']);
});

test('it closes the database on dispose', async () => {
  const testDatabase = await createTestDatabase();

  await testDatabase[Symbol.asyncDispose]();

  expect(listImages(testDatabase.db)).rejects.toThrow();
});
