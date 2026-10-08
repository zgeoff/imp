import { expect, test } from 'bun:test';
import type { Image } from '@imp/api';
import { imageCollection } from './image-collection';

test('it creates a default image', async () => {
  const image: Image = await imageCollection.create({});

  expect(image).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toSatisfy((value: string) => /^[a-z]{6}$/.test(value)),
    ref: expect.toSatisfy((value: string) => /^docker\.io\/library\/[a-z]{6}:latest$/.test(value)),
    digest: expect.toSatisfy((value: string) => /^sha256:[0-9a-f]{64}$/.test(value)),
    source: 'oci',
    createdAt: expect.toBeValidDate(),
    sizeBytes: expect.toSatisfy((bytes: number) => bytes > 0 && bytes % (1024 * 1024) === 0),
  });
});

test('it applies overrides on top of the defaults', async () => {
  const image: Image = await imageCollection.create({
    name: 'base',
    source: 'imp',
    sizeBytes: 512,
  });

  expect(image).toStrictEqual({
    id: expect.toBeString(),
    name: 'base',
    ref: expect.toBeString(),
    digest: expect.toBeString(),
    source: 'imp',
    createdAt: expect.toBeValidDate(),
    sizeBytes: 512,
  });
});
