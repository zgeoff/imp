import { expect, test } from 'bun:test';
import {
  IMPD_ORIGIN,
  LOGIN_URL,
  LOGOUT_URL,
  knownTokens,
  resolveLogin,
  resolveLogout,
} from './handlers';

test('#resolveLogin opens a session for a known token', async () => {
  await knownTokens.create({ token: 'secret' });

  const response = await fetch(LOGIN_URL, {
    method: 'POST',
    body: JSON.stringify({ token: 'secret' }),
  });

  expect(response.status).toBe(204);
});

test('#resolveLogin refuses a token impd does not know', async () => {
  await knownTokens.create({ token: 'secret' });

  const response = await fetch(LOGIN_URL, {
    method: 'POST',
    body: JSON.stringify({ token: 'nope' }),
  });

  expect(response.status).toBe(401);
});

test('#resolveLogin refuses a body that is not JSON', async () => {
  await knownTokens.create({ token: 'secret' });

  const response = await fetch(LOGIN_URL, { method: 'POST', body: 'secret' });

  expect(response.status).toBe(401);
});

test('#resolveLogin refuses a request from another site', async () => {
  await knownTokens.create({ token: 'secret' });

  const request = new Request(LOGIN_URL, {
    method: 'POST',
    headers: { origin: 'http://evil.test' },
    body: JSON.stringify({ token: 'secret' }),
  });

  const response = await resolveLogin({ request });

  expect(response.status).toBe(403);
});

test('#resolveLogout answers 204 to a request a browser marks same-origin', async () => {
  const response = await fetch(LOGOUT_URL, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
  });

  expect(response.status).toBe(204);
});

test('#resolveLogout refuses a request with neither Sec-Fetch-Site nor Origin', () => {
  const request = new Request(LOGOUT_URL, { method: 'POST' });

  const response = resolveLogout({ request });

  expect(response.status).toBe(403);
});

test('#resolveLogout refuses a request whose origin is null', () => {
  const request = new Request(LOGOUT_URL, { method: 'POST', headers: { origin: 'null' } });

  const response = resolveLogout({ request });

  expect(response.status).toBe(403);
});

test('#resolveLogout refuses a request a browser marks cross-site', () => {
  const request = new Request(LOGOUT_URL, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
  });

  const response = resolveLogout({ request });

  expect(response.status).toBe(403);
});

test('#resolveLogout answers 204 to a request whose origin is impd', () => {
  const request = new Request(LOGOUT_URL, { method: 'POST', headers: { origin: IMPD_ORIGIN } });

  const response = resolveLogout({ request });

  expect(response.status).toBe(204);
});
