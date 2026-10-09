import { faker } from '@faker-js/faker';
import type { CheckpointRecord } from '../db/checkpoints';

// A checkpoint as the checkpoints table reads it, labelled and sized; its
// imp a fresh id, its sizes and time arbitrary.
export function buildMockCheckpointRecord(
  overrides: Partial<CheckpointRecord> = {},
): CheckpointRecord {
  return {
    id: faker.string.alphanumeric({ length: 8, casing: 'lower' }),
    impId: faker.string.uuid(),
    label: faker.word.noun(),
    createdAt: faker.date.past(),
    sizeBytes: faker.number.int({ min: 1, max: 1024 ** 3 }),
    diskBytes: faker.number.int({ min: 1024 ** 3, max: 64 * 1024 ** 3 }),
    ...overrides,
  };
}
