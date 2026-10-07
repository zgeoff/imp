import { expect, test } from 'bun:test';
import { IMPD_ORIGIN, knownTokens } from './handlers';

test('#login opens a session for a known token', async () => {
  knownTokens.add('secret');

  const response = await fetch(`${IMPD_ORIGIN}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ token: 'secret' }),
  });

  expect(response.status).toBe(204);
});

test('#login refuses a token impd does not know', async () => {
  knownTokens.add('secret');

  const response = await fetch(`${IMPD_ORIGIN}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ token: 'nope' }),
  });

  expect(response.status).toBe(401);
});

test('#logout ends the session', async () => {
  const response = await fetch(`${IMPD_ORIGIN}/auth/logout`, { method: 'POST' });

  expect(response.status).toBe(204);
});
