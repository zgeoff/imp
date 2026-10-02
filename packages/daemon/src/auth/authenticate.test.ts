import { expect, test } from 'bun:test';
import { isSameOrigin, readCaller } from './authenticate';
import { buildSessionValue } from './session-cookie';

const NOW = 1_800_000_000_000;
const SESSION = `imp_session=${buildSessionValue('secret', NOW + 60_000)}`;

function buildRequest(headers: Readonly<Record<string, string>>): Request {
  return new Request('http://imp:7070/rpc/imps/list', { method: 'POST', headers });
}

test('it accepts the bearer token from anywhere, as the token, for good', () => {
  const request = buildRequest({ authorization: 'Bearer secret', origin: 'http://evil' });

  expect(readCaller(request, 'secret', NOW)).toEqual({ actor: 'token', expiresAt: null });
});

test('it accepts the session from a same-origin request, as the dashboard, until it expires', () => {
  const request = buildRequest({ cookie: SESSION, 'sec-fetch-site': 'same-origin' });

  expect(readCaller(request, 'secret', NOW)).toEqual({
    actor: 'dashboard',
    expiresAt: NOW + 60_000,
  });
});

test('a bad session cookie an imp planted first does not hide the real one', () => {
  const request = buildRequest({
    cookie: `imp_session=planted; ${SESSION}`,
    'sec-fetch-site': 'same-origin',
  });

  expect(readCaller(request, 'secret', NOW)).not.toBeNull();
});

test('it refuses the session from another port of the same host', () => {
  const request = buildRequest({ cookie: SESSION, 'sec-fetch-site': 'same-site' });

  expect(readCaller(request, 'secret', NOW)).toBeNull();
});

test('it refuses an expired session', () => {
  const request = buildRequest({ cookie: SESSION, 'sec-fetch-site': 'same-origin' });

  expect(readCaller(request, 'secret', NOW + 60_000)).toBeNull();
});

test('without fetch metadata it needs an origin naming this host and port', () => {
  expect(isSameOrigin(buildRequest({ origin: 'http://imp:7070' }))).toBe(true);

  // the scheme may differ behind a TLS front
  expect(isSameOrigin(buildRequest({ origin: 'https://imp:7070' }))).toBe(true);
  expect(isSameOrigin(buildRequest({ origin: 'http://imp:20001' }))).toBe(false);
  expect(isSameOrigin(buildRequest({ origin: 'http://other:7070' }))).toBe(false);
  expect(isSameOrigin(buildRequest({ origin: 'null' }))).toBe(false);
  expect(isSameOrigin(buildRequest({}))).toBe(false);
});

test('fetch metadata wins over a matching origin', () => {
  const request = buildRequest({ origin: 'http://imp:7070', 'sec-fetch-site': 'cross-site' });

  expect(isSameOrigin(request)).toBe(false);
});
