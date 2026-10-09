import { faker } from '@faker-js/faker';
import type { OAuthConfig } from '../secret-schema';

// A form-encoded token endpoint on an arbitrary host, for an arbitrary client
export function buildMockOAuthConfig(overrides: Partial<OAuthConfig> = {}): OAuthConfig {
  return {
    tokenUrl: `https://${faker.internet.domainName().toLowerCase()}/oauth/token`,
    clientId: faker.string.alphanumeric(16),
    tokenFormat: 'form',
    ...overrides,
  };
}
