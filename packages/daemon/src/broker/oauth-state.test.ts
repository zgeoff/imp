import { expect, test } from 'bun:test';
import {
  buildPendingState,
  formatOAuthState,
  isHeaderSafeToken,
  parseOAuthState,
  readIdClaims,
  readJwtExpiry,
} from './oauth-state';

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function buildJwt(claims: unknown): string {
  return `${encodeSegment({ alg: 'none' })}.${encodeSegment(claims)}.fake`;
}

test('a state file round-trips and anything else is not one', () => {
  const state = buildPendingState('fake-refresh-0');

  expect(parseOAuthState(formatOAuthState(state))).toEqual(state);
  expect(parseOAuthState('fake-refresh-0')).toBeNull();
  expect(parseOAuthState('{"v":2}')).toBeNull();
  expect(parseOAuthState('{"v":1,"refreshToken":""}')).toBeNull();
});

test('the id claims keep the account identifiers and drop the per-token ones', () => {
  const claims = readIdClaims(
    buildJwt({
      email: 'someone@example.com',
      org: { id: 'fake-org' },
      at_hash: 'a',
      c_hash: 'b',
      nonce: 'c',
      sid: 'd',
      jti: 'e',
    }),
  );

  expect(claims).toEqual({ email: 'someone@example.com', org: { id: 'fake-org' } });
  expect(readIdClaims(null)).toBeNull();
  expect(readIdClaims('fake-opaque')).toBeNull();
  expect(readIdClaims(buildJwt([1, 2]))).toBeNull();
});

test('a JWT expiry is read in milliseconds, and nothing else is one', () => {
  expect(readJwtExpiry(buildJwt({ exp: 1_900_000_000 }))).toBe(1_900_000_000_000);
  expect(readJwtExpiry(buildJwt({ exp: 'soon' }))).toBeNull();
  expect(readJwtExpiry(buildJwt({}))).toBeNull();
  expect(readJwtExpiry('fake-opaque')).toBeNull();
});

test('only printable ASCII without spaces can go into a header', () => {
  expect(isHeaderSafeToken('fake-access.1_2~3')).toBe(true);

  for (const token of ['', 'a b', 'a\r\nb', 'é']) {
    expect(isHeaderSafeToken(token)).toBe(false);
  }
});
