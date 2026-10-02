import { expect, test } from 'bun:test';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  buildSessionValue,
  isValidSession,
  readSessionCookie,
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

test('it reads the session from a cookie header among other cookies', () => {
  expect(readSessionCookie('a=1; imp_session=v1.2.abc; b=2')).toBe('v1.2.abc');
  expect(readSessionCookie('a=1')).toBeNull();
  expect(readSessionCookie(null)).toBeNull();
});

test('it removes only the session from a cookie header', () => {
  expect(removeSessionCookie('a=1; imp_session=v1.2.abc; b=x=y')).toBe('a=1; b=x=y');
  expect(removeSessionCookie('imp_session=v1.2.abc')).toBeNull();
  expect(removeSessionCookie('imp_session_other=1')).toBe('imp_session_other=1');
});

test('it sets an http-only strict cookie, secure behind TLS', () => {
  expect(buildSessionCookie('v', false)).toBe(
    'imp_session=v; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict',
  );

  expect(buildSessionCookie('v', true)).toEndWith('; Secure');
  expect(buildClearedSessionCookie(false)).toStartWith('imp_session=; Path=/; Max-Age=0;');
});
