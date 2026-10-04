import { expect, test } from 'bun:test';
import { ApprovalCodeSchema } from '@imp/api';
import {
  createApprovalCode,
  createCode,
  createToken,
  formatApprovalCode,
  isChallenge,
  isSameHash,
  isVerifierMatch,
  parseToken,
  toSecretHash,
} from './oauth-secrets';

// RFC 7636, appendix B
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

test('PKCE S256 matches the RFC’s example and nothing else', () => {
  expect(isChallenge(CHALLENGE)).toBeTrue();
  expect(isVerifierMatch(VERIFIER, CHALLENGE)).toBeTrue();
  expect(isVerifierMatch(`${VERIFIER}x`, CHALLENGE)).toBeFalse();
  expect(isVerifierMatch(VERIFIER, CHALLENGE.replace('E', 'F'))).toBeFalse();

  // a verifier is 43 to 128 unreserved characters
  expect(isVerifierMatch('short', CHALLENGE)).toBeFalse();
  expect(isVerifierMatch(`${VERIFIER}!`, CHALLENGE)).toBeFalse();
  expect(isChallenge(`${CHALLENGE}=`)).toBeFalse();
});

test('a token parses back only under its own kind', () => {
  const access = createToken('access');

  expect(access.text.startsWith('impat_')).toBeTrue();
  expect(parseToken('access', access.text)).toEqual({ id: access.id, secret: access.secret });
  expect(parseToken('refresh', access.text)).toBeNull();
  expect(isSameHash(toSecretHash(access.secret), access.hash)).toBeTrue();
  expect(isSameHash(toSecretHash('wrong'), access.hash)).toBeFalse();
  expect(isSameHash('', '')).toBeFalse();

  for (const text of ['impat_', 'impat_id', 'impat_.secret', 'impat_id.', 'impat_a.b.c']) {
    expect(parseToken('access', text)).toBeNull();
  }
});

test('a code is 256 bits and kept as its hash', () => {
  const code = createCode();

  expect(Buffer.from(code.text, 'base64url')).toHaveLength(32);
  expect(code.hash).toBe(toSecretHash(code.text));
});

test('an approval code is 8 symbols of 32, read back in any case and with the dash', () => {
  for (let index = 0; index < 50; index += 1) {
    const code = createApprovalCode();

    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(ApprovalCodeSchema.parse(formatApprovalCode(code).toLowerCase())).toBe(code);
  }

  expect(ApprovalCodeSchema.safeParse('ABCD-EFG0').success).toBeFalse();
});
