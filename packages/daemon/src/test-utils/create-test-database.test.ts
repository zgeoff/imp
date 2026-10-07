import { expect, test } from 'bun:test';
import { createImage, listImages } from '../db/images';
import { readRejectionMessage, setupTestDatabase } from './create-test-database';

test('#setupTestDatabase holds one image with the documented fields', async () => {
  await using testDatabase = await setupTestDatabase();

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

test('#setupTestDatabase returns the image row it wrote', async () => {
  await using testDatabase = await setupTestDatabase();

  const images = await listImages(testDatabase.db);

  expect(images).toStrictEqual([testDatabase.image]);
});

test('#setupTestDatabase opens a fresh database on each call', async () => {
  await using first = await setupTestDatabase();
  await using second = await setupTestDatabase();

  await createImage(first.db, {
    name: 'dev',
    ref: 'imp/dev:latest',
    digest: 'sha256:1111',
    sizeBytes: 2048,
  });

  const images = await listImages(second.db);

  expect(images.map((image) => image.name)).toStrictEqual(['base']);
});

test('#setupTestDatabase closes the database on dispose', async () => {
  const testDatabase = await setupTestDatabase();

  await testDatabase[Symbol.asyncDispose]();

  expect(listImages(testDatabase.db)).rejects.toThrow();
});

test('#readRejectionMessage returns the message of the rejection', async () => {
  const message = await readRejectionMessage(Promise.reject(new Error('the disk is full')));

  expect(message).toBe('the disk is full');
});

test('#readRejectionMessage returns a rejected value that is not an error as a string', async () => {
  // oxlint-disable-next-line prefer-promise-reject-errors -- a rejection need not be an Error
  const message = await readRejectionMessage(Promise.reject('the disk is full'));

  expect(message).toBe('the disk is full');
});

test('#readRejectionMessage throws when the promise resolves', () => {
  expect(readRejectionMessage(Promise.resolve('fine'))).rejects.toThrowWithMessage(
    Error,
    /^expected the promise to reject$/,
  );
});
