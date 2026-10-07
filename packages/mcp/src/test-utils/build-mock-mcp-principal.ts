import { faker } from '@faker-js/faker';
import { createImpClient } from '@zgeoff/imp-client';
import type { McpPrincipal } from '../http/http-transport';
import { createImpGuard } from '../imp-guard';

// A caller as the host resolves it for one MCP request: a manage-scope caller
// with no guard limits and a credential that never ends, its client aimed at
// an arbitrary impd. A test that calls impd overrides `client`.
export function buildMockMcpPrincipal(overrides: Partial<McpPrincipal> = {}): McpPrincipal {
  return {
    key: faker.internet.username(),
    scope: 'manage',
    client: createImpClient({ url: faker.internet.url() }),
    guard: createImpGuard({ all: true }),
    ends: null,
    ...overrides,
  };
}
