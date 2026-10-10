import { faker } from '@faker-js/faker';
import type { StoredPublicAuth } from '../db/imps';
import { buildCredentialHash } from '../https/public-auth';

// A public imp's auth as the imps table stores it: basic auth for an
// arbitrary user, with the hash of an arbitrary credential.
export function buildMockStoredPublicAuth(
  overrides: Partial<StoredPublicAuth> = {},
): StoredPublicAuth {
  return {
    auth: 'basic',
    user: faker.internet.username(),
    hash: buildCredentialHash(faker.string.alphanumeric(43)),
    ...overrides,
  };
}
