import { expect, mock, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { createTestDatabase } from '../test-utils/create-test-database';
import { readSession, readSessionCookies } from './session-cookie';
import { createSessionRoutes } from './session-routes';
import { loadTokenStore } from './token-store';

async function setupTest() {
  const database = await createTestDatabase();

  return {
    // the token store over this database, as impd loads it
    loadTokens: (rootToken: string) =>
      loadTokenStore({
        db: database.db,
        rootToken,
        now: Date.now,
        onRemove: () => {},
        isFileKey: () => false,
      }),
  };
}

test('#login sets a session cookie naming the token, for 30 days', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');
  const made = await tokens.create({ name: 'viewer', scope: 'read', imps: null });

  const [tokenId = ''] = made.secret.slice('imp_'.length).split('.');

  const routes = createSessionRoutes({
    tokens,
    rootToken: 'root-secret',
    now: () => 1_800_000_000_000,
  });

  const response = await routes.login(
    new Request('http://imp:7070/auth/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ token: made.secret }),
    }),
  );

  const [pair = ''] = (response.headers.get('set-cookie') ?? '').split(';');
  const [value] = readSessionCookies(pair);

  invariant(value);

  expect(response.status).toBe(204);

  expect(readSession(value, 'root-secret', 1_800_000_000_000)).toStrictEqual({
    tokenId,
    expiresAt: 1_800_000_000_000 + 30 * 24 * 60 * 60 * 1000,
  });
});

test('#login sets the plain cookie over plain HTTP', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const routes = createSessionRoutes({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await routes.login(
    new Request('http://imp:7070/auth/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ token: 'root-secret' }),
    }),
  );

  expect(response.headers.get('set-cookie')).toStartWith('imp_session=v2.root.');
});

test('#login sets the Secure __Host- cookie for an https request', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const routes = createSessionRoutes({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await routes.login(
    new Request('https://imp.example.com/auth/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ token: 'root-secret' }),
    }),
  );

  expect(response.headers.get('set-cookie')).toStartWith('__Host-imp_session=');
  expect(response.headers.get('set-cookie')).toEndWith('; Secure');
});

test('#login sets the Secure __Host- cookie behind a TLS front that says so', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const routes = createSessionRoutes({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await routes.login(
    new Request('http://imp:7070/auth/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ token: 'root-secret' }),
    }),
  );

  expect(response.headers.get('set-cookie')).toStartWith('__Host-imp_session=');
});

test('#login refuses a request from another origin', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const routes = createSessionRoutes({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await routes.login(
    new Request('http://imp:7070/auth/login', {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
      body: JSON.stringify({ token: 'root-secret' }),
    }),
  );

  expect({ status: response.status, body: await response.json() }).toStrictEqual({
    status: 403,
    body: { error: 'cross-origin' },
  });
});

test('#login refuses a token that authenticates nobody', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const routes = createSessionRoutes({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await routes.login(
    new Request('http://imp:7070/auth/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ token: 'wrong' }),
    }),
  );

  expect({ status: response.status, body: await response.json() }).toStrictEqual({
    status: 401,
    body: { error: 'unauthorized' },
  });
});

test('#login refuses a body that is not JSON', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const routes = createSessionRoutes({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await routes.login(
    new Request('http://imp:7070/auth/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
      body: 'token=root-secret',
    }),
  );

  expect(response.status).toBe(401);
});

test('#login refuses a body without a token', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const routes = createSessionRoutes({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await routes.login(
    new Request('http://imp:7070/auth/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ secret: 'root-secret' }),
    }),
  );

  expect(response.status).toBe(401);
});

test('#logout clears the plain cookie over plain HTTP and reports the logout', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const onLogout = mock(() => {});
  const routes = createSessionRoutes({ tokens, rootToken: 'root-secret', now: Date.now, onLogout });

  const response = routes.logout(
    new Request('http://imp:7070/auth/logout', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    }),
  );

  expect(response.status).toBe(204);

  expect(response.headers.getSetCookie()).toStrictEqual([
    'imp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict',
  ]);

  expect(onLogout).toHaveBeenCalledOnce();
});

test('#logout clears both cookies over HTTPS', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const routes = createSessionRoutes({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = routes.logout(
    new Request('https://imp.example.com/auth/logout', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    }),
  );

  expect(response.headers.getSetCookie()).toStrictEqual([
    'imp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict',
    '__Host-imp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure',
  ]);
});

test('#logout refuses a request from another origin, and reports no logout', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const onLogout = mock(() => {});
  const routes = createSessionRoutes({ tokens, rootToken: 'root-secret', now: Date.now, onLogout });

  const response = routes.logout(
    new Request('http://imp:7070/auth/logout', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
    }),
  );

  expect(response.status).toBe(403);
  expect(onLogout).not.toHaveBeenCalled();
});
