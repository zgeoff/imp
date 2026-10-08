import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ApprovalCodeSchema } from '@imp/api';
import {
  createApprovalCode,
  createCode,
  createId,
  createToken,
  formatApprovalCode,
  isChallenge,
  isSameHash,
  isVerifierMatch,
  parseToken,
  toSecretHash,
} from './oauth-secrets';

test('#isVerifierMatch matches the verifier of RFC 7636 appendix B to its challenge', () => {
  expect(
    isVerifierMatch(
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    ),
  ).toBeTrue();
});

test.each([
  ['dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXkx', 'a verifier with a character more'],
  ['short', 'a verifier under 43 characters'],
  ['dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk!', 'a verifier with a reserved character'],
  ['a'.repeat(129), 'a verifier over 128 characters'],
])('#isVerifierMatch refuses %p, %s', (verifier) => {
  expect(isVerifierMatch(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBeFalse();
});

test('#isVerifierMatch refuses the verifier against another challenge', () => {
  expect(
    isVerifierMatch(
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      'F9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    ),
  ).toBeFalse();
});

test('#isChallenge accepts 43 base64url characters', () => {
  expect(isChallenge('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBeTrue();
});

test('#isChallenge refuses a challenge with padding', () => {
  expect(isChallenge('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM=')).toBeFalse();
});

test('#createToken makes an access token under its prefix, with the hash of its secret', () => {
  const access = createToken('access');

  expect(access).toStrictEqual({
    id: expect.toBeString(),
    secret: expect.toBeString(),
    hash: createHash('sha256').update(access.secret).digest('hex'),
    text: `impat_${access.id}.${access.secret}`,
  });

  expect(`${access.id}.${access.secret}`).toMatch(/^[\w-]{16}\.[\w-]{43}$/);
});

test('#createToken makes a refresh token under its own prefix', () => {
  const refresh = createToken('refresh');

  expect(refresh.text).toBe(`imprt_${refresh.id}.${refresh.secret}`);
});

test('#parseToken reads a token back under its own kind', () => {
  const access = createToken('access');

  expect(parseToken('access', access.text)).toStrictEqual({ id: access.id, secret: access.secret });
});

test('#parseToken reads nothing from a token of the other kind', () => {
  const access = createToken('access');

  expect(parseToken('refresh', access.text)).toBeNull();
});

test.each([['impat_'], ['impat_id'], ['impat_.secret'], ['impat_id.'], ['impat_a.b.c']])(
  '#parseToken reads nothing from the malformed token %p',
  (text) => {
    expect(parseToken('access', text)).toBeNull();
  },
);

test('#toSecretHash gives the hex SHA-256 digest of the secret', () => {
  expect(toSecretHash('abc')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('#isSameHash matches the hash of the same secret', () => {
  expect(isSameHash(toSecretHash('secret'), toSecretHash('secret'))).toBeTrue();
});

test('#isSameHash refuses the hash of another secret', () => {
  expect(isSameHash(toSecretHash('wrong'), toSecretHash('secret'))).toBeFalse();
});

test('#isSameHash refuses two empty hashes', () => {
  expect(isSameHash('', '')).toBeFalse();
});

test('#isSameHash refuses a stored value of another length', () => {
  expect(isSameHash(toSecretHash('secret'), 'abcd')).toBeFalse();
});

test('#createCode makes 256 bits kept as their hash', () => {
  const code = createCode();

  expect(code).toStrictEqual({
    text: expect.toBeString(),
    hash: createHash('sha256').update(code.text).digest('hex'),
  });

  expect(code.text).toMatch(/^[\w-]{43}$/);
});

test('#createApprovalCode makes 8 symbols from the 32 that are not misread', () => {
  expect(createApprovalCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
});

test('#formatApprovalCode shows the code with a dash, which the approval schema reads back in any case', () => {
  const code = createApprovalCode();
  const shown = formatApprovalCode(code);

  expect(ApprovalCodeSchema.parse(shown.toLowerCase())).toBe(code);
});

test('#formatApprovalCode leaves out 0, which the approval schema refuses as misread', () => {
  const result = ApprovalCodeSchema.safeParse('ABCD-EFG0');

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_format' });
});

test('#formatApprovalCode puts the dash after the fourth symbol', () => {
  expect(formatApprovalCode('ABCDEFGH')).toBe('ABCD-EFGH');
});

test('#createId makes 20 base64url characters', () => {
  expect(createId()).toMatch(/^[\w-]{20}$/);
});
