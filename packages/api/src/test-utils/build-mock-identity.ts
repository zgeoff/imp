import { faker } from '@faker-js/faker';
import type { Identity } from '../token-schema';

// A root-like token: manage on every imp, granting nothing. The name is
// arbitrary; the scope and the patterns decide what the caller may do.
export function buildMockIdentity(overrides: Partial<Identity> = {}): Identity {
  return {
    kind: 'token',
    name: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/),
    scope: 'manage',
    imps: null,
    grantable: [],
    ...overrides,
  };
}
