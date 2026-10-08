import { createHash } from 'node:crypto';
import { faker } from '@faker-js/faker';
import type { TokenRecord } from '../db/tokens';

// A made token's row as the token store writes it: a manage token for every
// imp with no grantable list; its id, name, secret hash and age arbitrary.
export function buildMockTokenRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    id: faker.string.alphanumeric(16),
    name: faker.word.noun(),
    secretHash: createHash('sha256').update(faker.string.alphanumeric(43)).digest('hex'),
    scope: 'manage',
    imps: null,
    grantable: [],
    createdAt: faker.date.past(),
    ...overrides,
  };
}
