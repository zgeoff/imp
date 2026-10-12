import { faker } from '@faker-js/faker';
import type { NewCheckpoint } from '../db/checkpoints';

// A checkpoint as createCheckpoint takes it: an arbitrary id, label and size
// for a fresh imp id, with no disk size or time, so createCheckpoint's own
// defaults apply.
export function buildMockNewCheckpoint(overrides: Partial<NewCheckpoint> = {}): NewCheckpoint {
  return {
    id: faker.string.alphanumeric({ length: 12, casing: 'lower' }),
    impId: faker.string.uuid(),
    label: faker.word.noun(),
    sizeBytes: faker.number.int({ min: 1, max: 1024 ** 3 }),
    ...overrides,
  };
}
