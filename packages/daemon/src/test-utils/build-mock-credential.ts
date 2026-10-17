import { faker } from '@faker-js/faker';
import type { Credential } from '../broker/forward-request';

// A bearer credential of an arbitrary secret, sent to https://<host> for
// any method and path
export function buildMockCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    secretName: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/u),
    header: 'authorization',
    value: `Bearer ${faker.string.alphanumeric(24)}`,
    upstream: null,
    filter: null,
    ...overrides,
  };
}
