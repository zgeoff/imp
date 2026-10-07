import { faker } from '@faker-js/faker';
import type { Caller } from '../auth/caller';

// A caller as impd's authentication builds one for an API token with every
// scope: the kind and scope are fixed, the token and its name arbitrary.
export function buildMockCaller(overrides: Partial<Caller> = {}): Caller {
  const tokenId = overrides.tokenId === undefined ? faker.string.uuid() : overrides.tokenId;
  const name = overrides.name ?? faker.word.noun();

  return {
    kind: 'token',
    name,
    scope: 'manage',
    imps: null,
    grantable: [],
    tokenId,
    grantId: null,
    expiresAt: null,
    principal: tokenId === null ? null : `token:${tokenId}`,
    display: name,
    ...overrides,
  };
}
