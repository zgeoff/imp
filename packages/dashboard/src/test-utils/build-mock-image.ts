import { faker } from '@faker-js/faker';
import type { Image } from '@imp/api';

// an image pulled from a registry, as impd lists it
export function buildMockImage(overrides: Partial<Image> = {}): Image {
  const name = faker.string.alpha({ length: 6, casing: 'lower' });

  return {
    id: faker.string.uuid(),
    name,
    ref: `docker.io/library/${name}:latest`,
    digest: `sha256:${faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' })}`,
    source: 'oci',
    createdAt: faker.date.past(),
    sizeBytes: faker.number.int({ min: 1, max: 4096 }) * 1024 * 1024,
    ...overrides,
  };
}
