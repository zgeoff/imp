import { createHmac, timingSafeEqual } from 'node:crypto';

// The dashboard's session (docs/architecture/daemon.md, Dashboard): an
// expiry signed with the API token, so the browser never holds the token
const SESSION_COOKIE = 'imp_session';

// Over HTTPS. The browser takes a __Host- cookie only Secure, host-only and on
// /, so no other name under the domain, an imp's included, can set one.
const SECURE_SESSION_COOKIE = '__Host-imp_session';

const SESSION_COOKIES: ReadonlySet<string> = new Set([SESSION_COOKIE, SECURE_SESSION_COOKIE]);

export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
const VERSION = 'v1';

export function buildSessionValue(token: string, expiresAtMs: number): string {
  const expiry = String(expiresAtMs);

  return `${VERSION}.${expiry}.${buildSignature(token, expiry)}`;
}

export function isValidSession(value: string, token: string, nowMs: number): boolean {
  const [version, expiry, signature, ...rest] = value.split('.');

  if (version !== VERSION || expiry === undefined || signature === undefined || rest.length > 0) {
    return false;
  }

  if (!/^\d+$/.test(expiry) || Number(expiry) <= nowMs) {
    return false;
  }

  const given = Buffer.from(signature);
  const expected = Buffer.from(buildSignature(token, expiry));

  return given.length === expected.length && timingSafeEqual(given, expected);
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

function buildSignature(token: string, expiry: string): string {
  return createHmac('sha256', buildSessionKey(token))
    .update(`imp-session-${VERSION}.${expiry}`)
    .digest('base64url');
}

// a key of its own, derived from the token, so the MAC never keys on the
// token itself
function buildSessionKey(token: string): Buffer {
  return createHmac('sha256', token).update('imp-session-key').digest();
}
