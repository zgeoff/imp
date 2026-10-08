import { faker } from '@faker-js/faker';
import type { OAuthStateFile } from '../broker/oauth-state';

const HOUR_MS = 3_600_000;

// A ready state with every token present: refreshed at a past time, its
// access token good for 240 hours from then
export function buildMockOAuthStateFile(overrides: Partial<OAuthStateFile> = {}): OAuthStateFile {
  const refreshedAt = faker.date.past().getTime();

  return {
    v: 1,
    refreshToken: `fake-refresh-${faker.string.alphanumeric(12)}`,
    accessToken: `fake-access-${faker.string.alphanumeric(12)}`,
    idToken: `fake-id-${faker.string.alphanumeric(12)}`,
    expiresAt: refreshedAt + 240 * HOUR_MS,
    refreshedAt,
    status: 'ready',
    error: null,
    ...overrides,
  };
}
