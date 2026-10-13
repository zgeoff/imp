import { faker } from '@faker-js/faker';
import type { OAuthClientRecord } from '../db/oauth';

// A public MCP client as the OAuth store writes it: one redirect URI; its id,
// name and age arbitrary.
export function buildMockOAuthClientRecord(
  overrides: Partial<OAuthClientRecord> = {},
): OAuthClientRecord {
  return {
    id: faker.string.uuid(),
    name: faker.word.noun(),
    redirectUris: [faker.internet.url()],
    createdAt: faker.date.past(),
    ...overrides,
  };
}
