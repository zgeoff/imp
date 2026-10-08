import { faker } from '@faker-js/faker';
import type { Checkpoint } from '../checkpoint-schema';

// A labelled checkpoint with its size, as a current impd lists it. The date
// counts back from faker's reference date, which the preload fixes.
export function buildMockCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: `cp-${faker.string.alphanumeric({ length: 6, casing: 'lower' })}`,
    label: faker.word.noun(),
    createdAt: faker.date.past(),
    sizeBytes: faker.number.int({ min: 0, max: 2 ** 34 }),
    diskMib: faker.number.int({ min: 1024, max: 65_536 }),
    ...overrides,
  };
}
