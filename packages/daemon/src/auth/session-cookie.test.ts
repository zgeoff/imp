import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  buildClearedSessionCookies,
  buildSessionCookie,
  buildSessionValue,
  readSession,
  readSessionCookies,
  removeSessionCookie,
} from './session-cookie';

const NOW = 1_800_000_000_000;
const CLAIM = { tokenId: 'abcdefghijklmnop', expiresAt: NOW + 1000 };

test('it accepts a session it signed, naming its token, until the session expires', () => {
  const value = buildSessionValue('secret', CLAIM);

  expect(value).toMatch(/^v2\.abcdefghijklmnop\.\d+\.[\w-]{43}$/);
  expect(readSession(value, 'secret', NOW)).toEqual(CLAIM);
  expect(readSession(value, 'secret', NOW + 1000)).toBeNull();
});

test('it rejects a session signed with another root token', () => {
  expect(readSession(buildSessionValue('old', CLAIM), 'new', NOW)).toBeNull();
});

test('it rejects a session whose expiry or token was changed', () => {
  const [version, tokenId, , signature] = buildSessionValue('secret', CLAIM).split('.');
  const later = `${version ?? ''}.${tokenId ?? ''}.${String(NOW + 9999)}.${signature ?? ''}`;
  const root = `${version ?? ''}.root.${String(CLAIM.expiresAt)}.${signature ?? ''}`;

  expect(readSession(later, 'secret', NOW)).toBeNull();
  expect(readSession(root, 'secret', NOW)).toBeNull();
});

test('it rejects malformed sessions and v1 ones', () => {
  const valid = buildSessionValue('secret', CLAIM);

  for (const value of ['', 'v2', 'v2.x.y', `v1${valid.slice(2)}`, `${valid}.extra`, `${valid}x`]) {
    expect(readSession(value, 'secret', NOW)).toBeNull();
  }
});

test('it reads every session from a cookie header among other cookies', () => {
  expect(readSessionCookies('a=1; imp_session=x; b=2; imp_session=v1.2.a=b')).toEqual([
    'x',
    'v1.2.a=b',
  ]);

  expect(readSessionCookies('a=1')).toEqual([]);
  expect(readSessionCookies(null)).toEqual([]);
});

test('it removes only the session, under either name, from a cookie header', () => {
  expect(removeSessionCookie('a=1; imp_session=v1.2.abc; b=x=y')).toBe('a=1; b=x=y');
  expect(removeSessionCookie('a=1; __Host-imp_session=v1.2.abc')).toBe('a=1');
  expect(removeSessionCookie('imp_session=v1.2.abc; __Host-imp_session=v1.2.abc')).toBeNull();
  expect(removeSessionCookie('imp_session_other=1')).toBe('imp_session_other=1');
});

test('it reads the session under either name', () => {
  expect(readSessionCookies('__Host-imp_session=s; imp_session=p')).toEqual(['s', 'p']);
});

test('it sets an http-only strict cookie, a __Host- one behind TLS', () => {
  expect(buildSessionCookie('v', false)).toBe(
    'imp_session=v; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict',
  );

  expect(buildSessionCookie('v', true)).toBe(
    '__Host-imp_session=v; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict; Secure',
  );
});

test('a logout clears the plain cookie, and over TLS the __Host- one too', () => {
  expect(buildClearedSessionCookies(false)).toEqual([
    'imp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict',
  ]);

  expect(buildClearedSessionCookies(true)).toEqual([
    'imp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict',
    '__Host-imp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure',
  ]);
});

test('the signature keys on a key derived from the root token, not the token', () => {
  const signature = buildSessionValue('secret', CLAIM).split('.').at(-1);

  const keyedOnToken = createHmac('sha256', 'secret')
    .update(`imp-session-v2.${CLAIM.tokenId}.${String(CLAIM.expiresAt)}`)
    .digest('base64url');

  expect(signature).not.toBe(keyedOnToken);
});
