import { expect, test } from 'bun:test';
import { isAuthenticated, isSameOrigin } from './authenticate';
import { buildSessionValue } from './session-cookie';

const NOW = 1_800_000_000_000;
const SESSION = `imp_session=${buildSessionValue('secret', NOW + 60_000)}`;

function buildRequest(headers: Readonly<Record<string, string>>): Request {
  return new Request('http://imp:7070/rpc/imps/list', { method: 'POST', headers });
}

test('it accepts the bearer token from anywhere', () => {
  const request = buildRequest({ authorization: 'Bearer secret', origin: 'http://evil' });

  expect(isAuthenticated(request, 'secret', NOW)).toBe(true);
});

test('it accepts the session from a same-origin request', () => {
  const request = buildRequest({ cookie: SESSION, 'sec-fetch-site': 'same-origin' });

  expect(isAuthenticated(request, 'secret', NOW)).toBe(true);
});

test('it refuses the session from another port of the same host', () => {
  const request = buildRequest({ cookie: SESSION, 'sec-fetch-site': 'same-site' });

  expect(isAuthenticated(request, 'secret', NOW)).toBe(false);
});

test('it refuses an expired session', () => {
  const request = buildRequest({ cookie: SESSION, 'sec-fetch-site': 'same-origin' });

  expect(isAuthenticated(request, 'secret', NOW + 60_000)).toBe(false);
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
