import { expect, test } from 'bun:test';
import { deriveTokenHash } from './derive-token-hash';

test('it derives the base64url SHA-256 of a token', () => {
  // SHA-256 of "abc", from FIPS 180-2's examples
  expect(deriveTokenHash('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
});
