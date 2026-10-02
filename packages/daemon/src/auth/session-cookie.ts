import { createHmac, timingSafeEqual } from 'node:crypto';

// The dashboard's session (docs/architecture/daemon.md, Dashboard): the
// token it was made with, by id, and an expiry, signed with a key derived
// from the root token, so the browser never holds a token
const SESSION_COOKIE = 'imp_session';

// Over HTTPS. The browser takes a __Host- cookie only Secure, host-only and on
// /, so no other name under the domain, an imp's included, can set one.
const SECURE_SESSION_COOKIE = '__Host-imp_session';

const SESSION_COOKIES: ReadonlySet<string> = new Set([SESSION_COOKIE, SECURE_SESSION_COOKIE]);

export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

// v1 sessions carried no token; they no longer log anyone in
const VERSION = 'v2';

export interface SessionClaim {
  readonly tokenId: string;
  readonly expiresAt: number;
}

export function buildSessionValue(rootToken: string, claim: Readonly<SessionClaim>): string {
  const expiry = String(claim.expiresAt);

  return `${VERSION}.${claim.tokenId}.${expiry}.${buildSignature(rootToken, claim.tokenId, expiry)}`;
}

// the token and expiry of a valid session; null for one that is not valid.
// Whether the token still exists is the caller's to check.
export function readSession(value: string, rootToken: string, nowMs: number): SessionClaim | null {
  const [version, tokenId, expiry, signature, ...rest] = value.split('.');

  if (
    version !== VERSION ||
    tokenId === undefined ||
    expiry === undefined ||
    signature === undefined ||
    rest.length > 0
  ) {
    return null;
  }

  if (!/^\d+$/.test(expiry) || Number(expiry) <= nowMs) {
    return null;
  }

  const given = Buffer.from(signature);
  const expected = Buffer.from(buildSignature(rootToken, tokenId, expiry));

  return given.length === expected.length && timingSafeEqual(given, expected)
    ? { tokenId, expiresAt: Number(expiry) }
    : null;
}

// Every session cookie value in a Cookie header, under either name. An
// imp's page can set its own imp_session on a longer path, which the browser
// sends first, so the caller must try them all.
export function readSessionCookies(header: string | null): string[] {
  if (header === null) {
    return [];
  }

  return header
    .split(';')
    .map((pair) => pair.trim().split('='))
    .filter(([key]) => SESSION_COOKIES.has(key ?? ''))
    .map(([, ...value]) => value.join('='));
}

// Every other cookie of a Cookie header, or null when none is left. The wake
// proxy forwards cookies to imps, and a browser sends the session to every
// port of the host, imps' ports included.
export function removeSessionCookie(header: string): string | null {
  const kept = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '' && !SESSION_COOKIES.has(pair.split('=')[0] ?? ''));

  return kept.length === 0 ? null : kept.join('; ');
}

export function buildSessionCookie(value: string, secure: boolean): string {
  return buildCookie(value, SESSION_MAX_AGE_S, secure);
}

// Over HTTPS both names go: a session set over plain HTTP reaches the HTTPS
// origin too. Over HTTP a __Host- cookie cannot be set, nor cleared.
export function buildClearedSessionCookies(secure: boolean): readonly string[] {
  return secure
    ? [buildCookie('', 0, false), buildCookie('', 0, true)]
    : [buildCookie('', 0, false)];
}

function buildCookie(value: string, maxAgeS: number, secure: boolean): string {
  const name = secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;

  const attributes = [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${String(maxAgeS)}`,
    'HttpOnly',
    'SameSite=Strict',
  ];

  if (secure) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

function buildSignature(rootToken: string, tokenId: string, expiry: string): string {
  return createHmac('sha256', buildSessionKey(rootToken))
    .update(`imp-session-${VERSION}.${tokenId}.${expiry}`)
    .digest('base64url');
}

// a key of its own, derived from the root token, so the MAC never keys on
// the token itself
function buildSessionKey(rootToken: string): Buffer {
  return createHmac('sha256', rootToken).update('imp-session-key').digest();
}
