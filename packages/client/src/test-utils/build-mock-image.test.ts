import { expect, test } from 'bun:test';
import { ImageSchema } from '@imp/api';
import { buildMockImage } from './build-mock-image';

test('it builds a default image', () => {
  const image = buildMockImage();

  expect(image).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toBeString(),
    ref: expect.toEndWith(':latest'),
    digest: expect.toStartWith('sha256:'),
    source: 'oci',
    createdAt: expect.toBeValidDate(),
    sizeBytes: expect.toBeWithin(1, 4 * 1024 ** 3 + 1),
  });
});

test('it builds an image the api schema accepts', () => {
  const image = buildMockImage();

  expect(ImageSchema.parse(image)).toStrictEqual(image);
});

test('it applies overrides on top of the defaults', () => {
  const createdAt = new Date('2026-10-01T00:00:00.000Z');

  const image = buildMockImage({ name: 'web', source: 'imp', createdAt, sizeBytes: 7 });

  expect(image).toStrictEqual({
    id: expect.toBeString(),
    name: 'web',
    ref: expect.toEndWith(':latest'),
    digest: expect.toStartWith('sha256:'),
    source: 'imp',
    createdAt,
    sizeBytes: 7,
  });
});
