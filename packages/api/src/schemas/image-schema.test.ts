import { expect, test } from 'bun:test';
import { ImageSchema, ImageSourceSchema } from './image-schema';

test.each(['oci', 'imp'])('#ImageSourceSchema accepts the %s source', (input) => {
  expect(ImageSourceSchema.safeParse(input).data).toBe(input);
});

test('#ImageSourceSchema rejects the unknown source docker', () => {
  const result = ImageSourceSchema.safeParse('docker');

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_value' });
});

test('#ImageSchema accepts an image', () => {
  const payload = {
    id: 'img-1',
    name: 'base',
    ref: 'docker.io/library/alpine:3',
    digest: 'sha256:abc',
    source: 'oci',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    sizeBytes: 1_048_576,
  } as const;

  expect(ImageSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ImageSchema rejects a name that is not a valid name', () => {
  const result = ImageSchema.safeParse({
    id: 'img-1',
    name: 'Base',
    ref: 'docker.io/library/alpine:3',
    digest: 'sha256:abc',
    source: 'oci',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    sizeBytes: 1_048_576,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['name'],
    message: 'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  });
});

test('#ImageSchema rejects a source outside the source list', () => {
  const result = ImageSchema.safeParse({
    id: 'img-1',
    name: 'base',
    ref: 'docker.io/library/alpine:3',
    digest: 'sha256:abc',
    source: 'docker',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    sizeBytes: 1_048_576,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['source'], code: 'invalid_value' });
});

test('#ImageSchema rejects a negative size', () => {
  const result = ImageSchema.safeParse({
    id: 'img-1',
    name: 'base',
    ref: 'docker.io/library/alpine:3',
    digest: 'sha256:abc',
    source: 'oci',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    sizeBytes: -1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['sizeBytes'], code: 'too_small' });
});

test('#ImageSchema rejects a fractional size', () => {
  const result = ImageSchema.safeParse({
    id: 'img-1',
    name: 'base',
    ref: 'docker.io/library/alpine:3',
    digest: 'sha256:abc',
    source: 'oci',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    sizeBytes: 1.5,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['sizeBytes'], code: 'invalid_type' });
});
