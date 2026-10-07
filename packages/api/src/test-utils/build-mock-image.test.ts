import { expect, test } from 'bun:test';
import { ImageSchema } from '../image-schema';
import { buildMockImage } from './build-mock-image';

test('it builds a default image', () => {
  const image = buildMockImage();
  const received: unknown = image;

  expect(received).toStrictEqual({
    id: expect.any(String) as unknown,
    name: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    ref: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}:\d+\.\d+\.\d+$/) as unknown,
    digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown,
    source: 'oci',
    createdAt: expect.toBeBefore(new Date('2026-01-01T00:00:00.000Z')) as unknown,
    sizeBytes: expect.any(Number) as unknown,
  });

  expect(ImageSchema.parse(image)).toStrictEqual(image);
  expect(image.ref).toStartWith(`${image.name}:`);
});

test('it applies overrides on top of the defaults', () => {
  const image: unknown = buildMockImage({ name: 'tpl', source: 'imp', sizeBytes: 6 });

  expect(image).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'tpl',
    ref: expect.any(String) as unknown,
    digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown,
    source: 'imp',
    createdAt: expect.toBeValidDate() as unknown,
    sizeBytes: 6,
  });
});
