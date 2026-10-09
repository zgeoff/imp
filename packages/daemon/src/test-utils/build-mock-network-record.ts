import { faker } from '@faker-js/faker';
import type { NetworkRecord } from '../db/networks';

// A network as listNetworks reads it, with no members; its id, name and
// time arbitrary.
export function buildMockNetworkRecord(overrides: Partial<NetworkRecord> = {}): NetworkRecord {
  return {
    id: faker.string.uuid(),
    name: faker.string.alphanumeric({ length: 10, casing: 'lower' }),
    createdAt: faker.date.past(),
    imps: [],
    ...overrides,
  };
}
