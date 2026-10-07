import { faker } from '@faker-js/faker';
import type { Checkpoint } from '@imp/api';

// a checkpoint without a label, as `imp checkpoint` takes one
export function buildMockCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: faker.string.alphanumeric({ length: 10, casing: 'lower' }),
    createdAt: faker.date.past(),
    sizeBytes: faker.number.int({ min: 0, max: 1024 * 1024 * 1024 }),
    diskMib: faker.number.int({ min: 1, max: 64 }) * 1024,
    ...overrides,
  };
}
