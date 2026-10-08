import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { invariant } from '@imp/test-utils/invariant';
import {
  buildClearedSessionCookies,
  buildSessionCookie,
  buildSessionValue,
  readSession,
  readSessionCookies,
  removeSessionCookie,
} from './session-cookie';

test('#buildSessionValue signs the version, the token and the expiry', () => {
  const value = buildSessionValue('secret', {
    tokenId: 'abcdefghijklmnop',
    expiresAt: 1_800_000_001_000,
  });

  expect(value).toMatch(/^v2\.abcdefghijklmnop\.1800000001000\.[\w-]{43}$/);
});

test('#buildSessionValue keys the signature on a key derived from the root token, not the token', () => {
  const value = buildSessionValue('secret', {
    tokenId: 'abcdefghijklmnop',
    expiresAt: 1_800_000_001_000,
  });

  const keyedOnToken = createHmac('sha256', 'secret')
    .update('imp-session-v2.abcdefghijklmnop.1800000001000')
    .digest('base64url');

  const signature = value.split('.').at(-1);

  invariant(signature);

  expect(signature).not.toBe(keyedOnToken);
});

test('#readSession accepts a session it signed, naming its token, before it expires', () => {
  const claim = { tokenId: 'abcdefghijklmnop', expiresAt: 1_800_000_001_000 };
  const value = buildSessionValue('secret', claim);

  expect(readSession(value, 'secret', 1_800_000_000_999)).toStrictEqual(claim);
});

test('#readSession rejects a session at its expiry', () => {
  const value = buildSessionValue('secret', {
    tokenId: 'abcdefghijklmnop',
    expiresAt: 1_800_000_001_000,
  });

  expect(readSession(value, 'secret', 1_800_000_001_000)).toBeNull();
});

test('#readSession rejects a session signed with another root token', () => {
  const value = buildSessionValue('old', {
    tokenId: 'abcdefghijklmnop',
    expiresAt: 1_800_000_001_000,
  });

  expect(readSession(value, 'new', 1_800_000_000_000)).toBeNull();
});

test('#readSession rejects a session whose expiry was changed', () => {
  const [version, tokenId, , signature] = buildSessionValue('secret', {
    tokenId: 'abcdefghijklmnop',
    expiresAt: 1_800_000_001_000,
  }).split('.');

  const later = `${String(version)}.${String(tokenId)}.1800000009999.${String(signature)}`;

  expect(readSession(later, 'secret', 1_800_000_000_000)).toBeNull();
});

test('#readSession rejects a session whose token was changed to root', () => {
  const [version, , expiry, signature] = buildSessionValue('secret', {
    tokenId: 'abcdefghijklmnop',
    expiresAt: 1_800_000_001_000,
  }).split('.');

  const root = `${String(version)}.root.${String(expiry)}.${String(signature)}`;

  expect(readSession(root, 'secret', 1_800_000_000_000)).toBeNull();
});

test.each([
  ['', 'empty'],
  ['v2', 'only a version'],
  ['v2.x.y', 'no signature'],
  ['v2.abcdefghijklmnop.soon.c2ln', 'an expiry that is not a number'],
])('#readSession rejects %p, which has %s', (value) => {
  expect(readSession(value, 'secret', 1_800_000_000_000)).toBeNull();
});

test('#readSession rejects a v1 session that carries the same signature', () => {
  const valid = buildSessionValue('secret', {
    tokenId: 'abcdefghijklmnop',
    expiresAt: 1_800_000_001_000,
  });

  expect(readSession(`v1${valid.slice(2)}`, 'secret', 1_800_000_000_000)).toBeNull();
});

test('#readSession rejects a valid session with a part added', () => {
  const valid = buildSessionValue('secret', {
    tokenId: 'abcdefghijklmnop',
    expiresAt: 1_800_000_001_000,
  });

  expect(readSession(`${valid}.extra`, 'secret', 1_800_000_000_000)).toBeNull();
});

test('#readSession rejects a valid session with its signature lengthened', () => {
  const valid = buildSessionValue('secret', {
    tokenId: 'abcdefghijklmnop',
    expiresAt: 1_800_000_001_000,
  });

  expect(readSession(`${valid}x`, 'secret', 1_800_000_000_000)).toBeNull();
});

test('#readSessionCookies reads every session among other cookies, in order', () => {
  expect(readSessionCookies('a=1; imp_session=x; b=2; imp_session=v1.2.a=b')).toStrictEqual([
    'x',
    'v1.2.a=b',
  ]);
});

test('#readSessionCookies reads the session under either name', () => {
  expect(readSessionCookies('__Host-imp_session=s; imp_session=p')).toStrictEqual(['s', 'p']);
});

test('#readSessionCookies reads none from a header without a session', () => {
  expect(readSessionCookies('a=1')).toStrictEqual([]);
});

test('#readSessionCookies reads none without a cookie header', () => {
  expect(readSessionCookies(null)).toStrictEqual([]);
});

test.each([
  ['a=1; imp_session=v1.2.abc; b=x=y', 'a=1; b=x=y'],
  ['a=1; __Host-imp_session=v1.2.abc', 'a=1'],
  ['imp_session=v1.2.abc; __Host-imp_session=v1.2.abc', null],
  ['imp_session_other=1', 'imp_session_other=1'],
])('#removeSessionCookie turns %p into %p', (header, kept) => {
  expect(removeSessionCookie(header)).toBe(kept);
});

test('#buildSessionCookie sets an http-only strict cookie over plain HTTP', () => {
  expect(buildSessionCookie('v', false)).toBe(
    'imp_session=v; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict',
  );
});

test('#buildSessionCookie sets a Secure __Host- cookie behind TLS', () => {
  expect(buildSessionCookie('v', true)).toBe(
    '__Host-imp_session=v; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict; Secure',
  );
});

test('#buildClearedSessionCookies clears the plain cookie over plain HTTP', () => {
  expect(buildClearedSessionCookies(false)).toStrictEqual([
    'imp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict',
  ]);
});

test('#buildClearedSessionCookies clears both cookies behind TLS', () => {
  expect(buildClearedSessionCookies(true)).toStrictEqual([
    'imp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict',
    '__Host-imp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure',
  ]);
});
