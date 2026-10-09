import { faker } from '@faker-js/faker';
import type { Extent } from '../storage/fiemap';

// One FIEMAP extent as readExtents returns it: an unshared, allocated extent
// at an arbitrary block-aligned place in the file and on the disk.
export function buildMockExtent(overrides: Partial<Extent> = {}): Extent {
  return {
    logical: faker.number.int({ max: 1_000_000 }) * 4096,
    physical: faker.number.int({ max: 1_000_000 }) * 4096,
    length: faker.number.int({ min: 1, max: 1024 }) * 4096,
    flags: 0,
    ...overrides,
  };
}
