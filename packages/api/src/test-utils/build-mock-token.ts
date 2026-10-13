import { faker } from '@faker-js/faker';
import type { Token } from '../schemas/token-schema';

// A manage token on every imp, with no SSH keys, nothing it may grant
// and no images it may add.
// The date counts back from faker's reference date, which the preload fixes.
export function buildMockToken(overrides: Partial<Token> = {}): Token {
  return {
    name: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/),
    scope: 'manage',
    imps: null,
    sshKeys: [],
    grantable: [],
    imageRefPrefix: null,
    createdAt: faker.date.past(),
    ...overrides,
  };
}
