import { expect, test } from 'bun:test';
import { buildStubBrokerJwt } from '../test-utils/build-stub-broker-jwt';
import {
  buildPendingState,
  formatOAuthState,
  isHeaderSafeToken,
  parseOAuthState,
  readIdClaims,
  readJwtExpiry,
} from './oauth-state';

test('it builds a pending state that holds only the refresh token', () => {
  expect(buildPendingState('fake-refresh-0')).toStrictEqual({
    v: 1,
    refreshToken: 'fake-refresh-0',
    accessToken: null,
    idToken: null,
    expiresAt: null,
    refreshedAt: null,
    status: 'pending',
    error: null,
  });
});

test('it reads back a state file it formatted', () => {
  const state = {
    v: 1,
    refreshToken: 'fake-refresh-0',
    accessToken: 'fake-access-0',
    idToken: 'fake-id-0',
    expiresAt: 1_900_000_000_000,
    refreshedAt: 1_890_000_000_000,
    status: 'ready',
    error: null,
  } as const;

  expect(parseOAuthState(formatOAuthState(state))).toStrictEqual(state);
});

test('it reads text that is not JSON as no state file', () => {
  expect(parseOAuthState('fake-refresh-0')).toBeNull();
});

test('it reads a state file of another version as no state file', () => {
  expect(
    parseOAuthState(
      JSON.stringify({
        v: 2,
        refreshToken: 'fake-refresh-0',
        accessToken: null,
        idToken: null,
        expiresAt: null,
        refreshedAt: null,
        status: 'pending',
        error: null,
      }),
    ),
  ).toBeNull();
});

test('it reads a state file with an empty refresh token as no state file', () => {
  expect(
    parseOAuthState(
      JSON.stringify({
        v: 1,
        refreshToken: '',
        accessToken: null,
        idToken: null,
        expiresAt: null,
        refreshedAt: null,
        status: 'pending',
        error: null,
      }),
    ),
  ).toBeNull();
});

test('it keeps the account claims of an ID token and drops the per-token ones', () => {
  const idToken = buildStubBrokerJwt({
    email: 'someone@example.com',
    org: { id: 'fake-org' },
    at_hash: 'a',
    c_hash: 'b',
    nonce: 'c',
    sid: 'd',
    jti: 'e',
  });

  expect(readIdClaims(idToken)).toStrictEqual({
    email: 'someone@example.com',
    org: { id: 'fake-org' },
  });
});

test('it reads no claims without an ID token', () => {
  expect(readIdClaims(null)).toBeNull();
});

test('it reads no claims from an opaque token', () => {
  expect(readIdClaims('fake-opaque')).toBeNull();
});

test('it reads no claims from a JWT whose payload is an array', () => {
  expect(readIdClaims(buildStubBrokerJwt([1, 2]))).toBeNull();
});

test('it reads a JWT expiry in milliseconds', () => {
  expect(readJwtExpiry(buildStubBrokerJwt({ exp: 1_900_000_000 }))).toBe(1_900_000_000_000);
});

test.each([
  ['a string', 'soon'],
  ['zero', 0],
  ['a negative number', -1],
])('it reads no expiry from a JWT whose exp is %s', (_what, exp) => {
  expect(readJwtExpiry(buildStubBrokerJwt({ exp }))).toBeNull();
});

test('it reads no expiry from a JWT whose exp overflows to infinity', () => {
  const payload = Buffer.from('{"exp":1e400}').toString('base64url');

  expect(readJwtExpiry(`e30.${payload}.fake`)).toBeNull();
});

test('it reads no expiry from a JWT without exp', () => {
  expect(readJwtExpiry(buildStubBrokerJwt({}))).toBeNull();
});

test('it reads no expiry from an opaque token', () => {
  expect(readJwtExpiry('fake-opaque')).toBeNull();
});

test('it takes printable ASCII without spaces as header safe', () => {
  expect(isHeaderSafeToken('fake-access.1_2~3')).toBeTrue();
});

test('it takes a token of 16384 characters as header safe', () => {
  expect(isHeaderSafeToken('a'.repeat(16_384))).toBeTrue();
});

test.each([
  ['an empty token', ''],
  ['a space', 'a b'],
  ['a line break', 'a\r\nb'],
  ['a non-ASCII character', 'é'],
  ['16385 characters', 'a'.repeat(16_385)],
])('it refuses a token with %s as header safe', (_what, token) => {
  expect(isHeaderSafeToken(token)).toBeFalse();
});
