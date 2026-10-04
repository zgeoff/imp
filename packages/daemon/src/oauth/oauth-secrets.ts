import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// The public MCP route's credentials: `<prefix><id>.<secret>`, as imp
// tokens are, with prefixes of their own. 256 random bits need no slow
// hash, so the secret's SHA-256 is compared in constant time.

export type OAuthTokenKind = 'access' | 'refresh';

const PREFIXES: Readonly<Record<OAuthTokenKind, string>> = { access: 'impat_', refresh: 'imprt_' };

// 32 symbols, with no 0, O, 1 or I to misread: 8 of them are 40 bits
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export interface MintedSecret {
  readonly id: string;
  readonly secret: string;
  readonly hash: string;
  readonly text: string;
}

export function createToken(kind: OAuthTokenKind): MintedSecret {
  const id = randomBytes(12).toString('base64url');
  const secret = randomBytes(32).toString('base64url');

  return { id, secret, hash: toSecretHash(secret), text: `${PREFIXES[kind]}${id}.${secret}` };
}

export function parseToken(
  kind: OAuthTokenKind,
  text: string,
): { readonly id: string; readonly secret: string } | null {
  const prefix = PREFIXES[kind];

  if (!text.startsWith(prefix)) {
    return null;
  }

  const [id, secret, ...rest] = text.slice(prefix.length).split('.');

  if (id === undefined || secret === undefined || rest.length > 0 || id === '' || secret === '') {
    return null;
  }

  return { id, secret };
}

// an authorization code: opaque, 256 bits, kept only as its hash
export function createCode(): { readonly text: string; readonly hash: string } {
  const text = randomBytes(32).toString('base64url');

  return { text, hash: toSecretHash(text) };
}

// the code a sign-in page shows and `imp oauth approve` takes: 40 bits,
// enough because only a holder of a named imp token can try one, at a
// limited rate, within its 10 minutes
export function createApprovalCode(): string {
  const bytes = randomBytes(CODE_LENGTH);

  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

export function formatApprovalCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function createId(): string {
  return randomBytes(15).toString('base64url');
}

export function toSecretHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

// both are hex SHA-256 digests, so the lengths match and the compare is
// constant time; the check guards a stored value that is not one
export function isSameHash(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'hex');
  const b = Buffer.from(expected, 'hex');

  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

// PKCE S256 (RFC 7636): the challenge is the verifier's SHA-256 in
// base64url, and a verifier is 43 to 128 unreserved characters
export function isVerifierMatch(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return false;
  }

  const derived = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function isChallenge(text: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(text);
}
