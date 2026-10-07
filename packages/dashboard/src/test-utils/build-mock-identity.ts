import { faker } from '@faker-js/faker';
import type { Identity } from '@imp/api';

// a dashboard session made with a manage token for every imp
export function buildMockIdentity(overrides: Partial<Identity> = {}): Identity {
  return {
    kind: 'dashboard',
    name: faker.string.alpha({ length: 8, casing: 'lower' }),
    scope: 'manage',
    imps: null,
    grantable: [],
    ...overrides,
  };
}
