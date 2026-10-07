import { faker } from '@faker-js/faker';
import type { Token } from '@imp/api';

// a read token for every imp, with no SSH keys and nothing to grant
export function buildMockToken(overrides: Partial<Token> = {}): Token {
  return {
    name: faker.string.alpha({ length: 8, casing: 'lower' }),
    scope: 'read',
    imps: null,
    sshKeys: [],
    grantable: [],
    createdAt: faker.date.past(),
    ...overrides,
  };
}
