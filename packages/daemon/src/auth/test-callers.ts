import type { Caller } from './caller';

// a caller for tests: a made token with every scope unless told otherwise
export function buildTestCaller(overrides: Partial<Caller> = {}): Caller {
  return {
    kind: 'token',
    name: 'test',
    scope: 'manage',
    imps: null,
    grantable: [],
    tokenId: 'test-token-id',
    expiresAt: null,
    principal: 'token:test-token-id',
    display: 'test',
    ...overrides,
  };
}
