import { faker } from '@faker-js/faker';
import type { LeaseRecord } from '../db/leases';

// A lease row as the lease store reads it: a token's lease that holds with no
// end; its imp, owner, label and age arbitrary.
export function buildMockLeaseRecord(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    impId: faker.string.uuid(),
    principal: `token:${faker.string.uuid()}`,
    label: faker.word.verb(),
    display: faker.word.noun(),
    until: null,
    createdAt: faker.date.past(),
    ...overrides,
  };
}
