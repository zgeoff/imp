import { faker } from '@faker-js/faker';
import type { Image } from '@imp/api';

// An image as impd answers one: pulled from a registry, with an arbitrary
// name, reference, digest, date and size.
export function buildMockImage(overrides: Partial<Image> = {}): Image {
  const name = faker.string.alpha({ length: 8, casing: 'lower' });

  return {
    id: faker.string.uuid(),
    name,
    ref: `${faker.string.alpha({ length: 6, casing: 'lower' })}:latest`,
    digest: `sha256:${faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' })}`,
    source: 'oci',
    createdAt: faker.date.recent(),
    sizeBytes: faker.number.int({ min: 1, max: 4 * 1024 ** 3 }),
    ...overrides,
  };
}
