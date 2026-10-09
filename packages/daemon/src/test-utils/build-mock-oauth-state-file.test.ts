import { expect, test } from 'bun:test';
import { buildMockOAuthStateFile } from './build-mock-oauth-state-file';

test('it builds a default oauth state file', () => {
  const state = buildMockOAuthStateFile();
  const received: unknown = state;

  expect(received).toStrictEqual({
    v: 1,
    refreshToken: expect.stringMatching(/^fake-refresh-[A-Za-z0-9]{12}$/) as unknown,
    accessToken: expect.stringMatching(/^fake-access-[A-Za-z0-9]{12}$/) as unknown,
    idToken: expect.stringMatching(/^fake-id-[A-Za-z0-9]{12}$/) as unknown,
    expiresAt: (state.refreshedAt ?? 0) + 240 * 3_600_000,
    refreshedAt: expect.any(Number) as unknown,
    status: 'ready',
    error: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  const state: unknown = buildMockOAuthStateFile({
    refreshToken: 'fake-refresh-0',
    expiresAt: null,
    status: 'needs_login',
    error: 'invalid_grant',
  });

  expect(state).toStrictEqual({
    v: 1,
    refreshToken: 'fake-refresh-0',
    accessToken: expect.stringMatching(/^fake-access-/) as unknown,
    idToken: expect.stringMatching(/^fake-id-/) as unknown,
    expiresAt: null,
    refreshedAt: expect.any(Number) as unknown,
    status: 'needs_login',
    error: 'invalid_grant',
  });
});
