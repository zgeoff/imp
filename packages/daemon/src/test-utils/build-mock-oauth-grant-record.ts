import { faker } from '@faker-js/faker';
import type { OAuthGrantRecord } from '../db/oauth';

// One approval as the OAuth store writes it: a manage grant for every imp,
// never used; its ids, resource and age arbitrary, and its client and token
// fresh ids that no row holds.
export function buildMockOAuthGrantRecord(
  overrides: Partial<OAuthGrantRecord> = {},
): OAuthGrantRecord {
  return {
    id: faker.string.uuid(),
    clientId: faker.string.uuid(),
    tokenId: faker.string.alphanumeric(16),
    scope: 'manage',
    imps: null,
    resource: `${faker.internet.url({ appendSlash: false })}/mcp`,
    createdAt: faker.date.past(),
    lastUsedAt: null,
    ...overrides,
  };
}
