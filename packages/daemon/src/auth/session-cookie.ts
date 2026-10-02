import { createHmac, timingSafeEqual } from 'node:crypto';

// The dashboard's session (docs/architecture/daemon.md, Dashboard): an
// expiry signed with the API token, so the browser never holds the token
const SESSION_COOKIE = 'imp_session';

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

// the session cookie's value from a Cookie header, or null
export function readSessionCookie(header: string | null): string | null {
  if (header === null) {
    return null;
  }

  for (const pair of header.split(';')) {
    const [key, ...value] = pair.trim().split('=');

    if (key === SESSION_COOKIE) {
      return value.join('=');
    }
  }

  return null;
}

// Every other cookie of a Cookie header, or null when none is left. The wake
// proxy forwards cookies to imps, and a browser sends the session to every
// port of the host, imps' ports included.
export function removeSessionCookie(header: string): string | null {
  const kept = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '' && pair.split('=')[0] !== SESSION_COOKIE);

  return kept.length === 0 ? null : kept.join('; ');
}

export function buildSessionCookie(value: string, secure: boolean): string {
  return buildCookie(value, SESSION_MAX_AGE_S, secure);
}

export function buildClearedSessionCookie(secure: boolean): string {
  return buildCookie('', 0, secure);
}

function buildCookie(value: string, maxAgeS: number, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
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
  return createHmac('sha256', token).update(`imp-session-${VERSION}.${expiry}`).digest('base64url');
}
