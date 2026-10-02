import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  buildClearedSessionCookies,
  buildSessionCookie,
  buildSessionValue,
  isValidSession,
  readSessionCookies,
  removeSessionCookie,
} from './session-cookie';

const NOW = 1_800_000_000_000;

test('it accepts a session it signed until the session expires', () => {
  const value = buildSessionValue('secret', NOW + 1000);

  expect(value).toMatch(/^v1\.\d+\.[\w-]{43}$/);
  expect(isValidSession(value, 'secret', NOW)).toBe(true);
  expect(isValidSession(value, 'secret', NOW + 1000)).toBe(false);
});

test('it rejects a session signed with another token', () => {
  expect(isValidSession(buildSessionValue('old', NOW + 1000), 'new', NOW)).toBe(false);
});

test('it rejects a session whose expiry was changed', () => {
  const [version, , signature] = buildSessionValue('secret', NOW + 1000).split('.');

  expect(
    isValidSession(`${version ?? ''}.${String(NOW + 9999)}.${signature ?? ''}`, 'secret', NOW),
  ).toBe(false);
});

test('it rejects malformed sessions', () => {
  const valid = buildSessionValue('secret', NOW + 1000);

  for (const value of ['', 'v1', 'v1.x.y', `v2${valid.slice(2)}`, `${valid}.extra`, `${valid}x`]) {
    expect(isValidSession(value, 'secret', NOW)).toBe(false);
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

test('the signature keys on a key derived from the token, not the token', () => {
  const signature = buildSessionValue('secret', NOW).split('.').at(-1);

  const keyedOnToken = createHmac('sha256', 'secret')
    .update(`imp-session-v1.${String(NOW)}`)
    .digest('base64url');

  expect(signature).not.toBe(keyedOnToken);
});
