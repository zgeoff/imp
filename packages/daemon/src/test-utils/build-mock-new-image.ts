import { faker } from '@faker-js/faker';
import type { NewImage } from '../db/images';

// An image as createImage takes it: a docker image with an arbitrary name,
// reference, digest and size.
export function buildMockNewImage(overrides: Partial<NewImage> = {}): NewImage {
  return {
    name: faker.string.alphanumeric({ length: 12, casing: 'lower' }),
    ref: `imp/${faker.word.noun()}:latest`,
    digest: `sha256:${faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' })}`,
    sizeBytes: faker.number.int({ min: 1, max: 1024 ** 3 }),
    ...overrides,
  };
}
