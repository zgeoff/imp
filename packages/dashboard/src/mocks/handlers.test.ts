import { expect, onTestFinished, test } from 'bun:test';
import type { Identity } from '@imp/api';
import { createImpClient } from '@zgeoff/imp-client';
import { isUnauthorized } from '../lib/build-query-client';
import { sessionCollection } from './db/session-collection';
import { tokenCollection } from './db/token-collection';
import {
  IMPD_ORIGIN,
  LOGIN_URL,
  LOGOUT_URL,
  RPC_URL,
  resolveLogin,
  resolveLogout,
  resolveRpc,
} from './handlers';

test('#resolveLogin answers 204 to the secret of a known token', async () => {
  await tokenCollection.create({ secret: 'imp_ci.secret' });

  const response = await fetch(LOGIN_URL, {
    method: 'POST',
    body: JSON.stringify({ token: 'imp_ci.secret' }),
  });

  expect(response.status).toBe(204);
});

test('#resolveLogin opens a session with the scope and imps of the token', async () => {
  await tokenCollection.create({
    name: 'dev',
    scope: 'exec',
    imps: ['dev-*'],
    secret: 'imp_dev.secret',
  });

  await fetch(LOGIN_URL, { method: 'POST', body: JSON.stringify({ token: 'imp_dev.secret' }) });

  const sessions: (Identity & { readonly expiresAt: Date })[] = sessionCollection.findMany();

  expect(sessions).toStrictEqual([
    {
      kind: 'dashboard',
      name: 'dev',
      scope: 'exec',
      imps: ['dev-*'],
      grantable: [],
      expiresAt: expect.toBeAfter(new Date()),
    },
  ]);
});

test('#resolveLogin refuses a token impd does not know', async () => {
  await tokenCollection.create({ secret: 'imp_ci.secret' });

  const response = await fetch(LOGIN_URL, {
    method: 'POST',
    body: JSON.stringify({ token: 'nope' }),
  });

  expect(response.status).toBe(401);
});

test('#resolveLogin opens no session for a token impd does not know', async () => {
  await tokenCollection.create({ secret: 'imp_ci.secret' });

  await fetch(LOGIN_URL, { method: 'POST', body: JSON.stringify({ token: 'nope' }) });

  expect(sessionCollection.count()).toBe(0);
});

test('#resolveLogin refuses a body that is not JSON', async () => {
  await tokenCollection.create({ secret: 'imp_ci.secret' });

  const response = await fetch(LOGIN_URL, { method: 'POST', body: 'imp_ci.secret' });

  expect(response.status).toBe(401);
});

test('#resolveLogin refuses a request from another site', async () => {
  await tokenCollection.create({ secret: 'imp_ci.secret' });

  const request = new Request(LOGIN_URL, {
    method: 'POST',
    headers: { origin: 'http://evil.test' },
    body: JSON.stringify({ token: 'imp_ci.secret' }),
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

test('#resolveLogout ends the session of the browser', async () => {
  await sessionCollection.create({});

  await fetch(LOGOUT_URL, { method: 'POST' });

  expect(sessionCollection.count()).toBe(0);
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

test('#resolveRpc answers a call without a session with the 401 of impd', () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  expect(client.imps.list()).rejects.toSatisfy(isUnauthorized);
});

test('#resolveRpc answers the 404 of impd to a procedure the mock impd leaves out', async () => {
  await sessionCollection.create({});

  const response = await fetch(`${RPC_URL}/backups/list`, { method: 'POST' });
  const body = await response.text();

  expect(response.status).toBe(404);
  expect(body).toBe('not found');
});

test('#resolveRpc answers a session that has expired with the 401 of impd', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({ expiresAt: new Date(Date.now() - 1000) });

  expect(client.imps.list()).rejects.toSatisfy(isUnauthorized);
});

test('#resolveRpc answers a call from another site with the 401 of impd', async () => {
  await sessionCollection.create({});

  const request = new Request(`${RPC_URL}/tokens/whoami`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
  });

  const response = await resolveRpc({ request });

  expect(response.status).toBe(401);
});

test('#resolveRpc answers a call a browser marks same-origin with the session', async () => {
  await sessionCollection.create({});

  const request = new Request(`${RPC_URL}/tokens/whoami`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
  });

  const response = await resolveRpc({ request });

  expect(response.status).toBe(200);
});

test('#resolveLogout ends the event streams the dashboard holds open', async () => {
  const client = createImpClient({ url: IMPD_ORIGIN });

  await sessionCollection.create({});

  const stream = await client.events.stream();

  onTestFinished(() => stream.return(undefined));

  const pending = stream.next();

  await fetch(LOGOUT_URL, { method: 'POST' });

  const ended = await pending;

  expect(ended.done).toBe(true);
});
