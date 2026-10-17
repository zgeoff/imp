import { expect, mock, test } from 'bun:test';
import { ApprovalCodeSchema } from '@impz/api';
import { invariant } from '@impz/test-utils/invariant';
import { createRevocations } from '../auth/revocations';
import { loadTokenStore } from '../auth/token-store';
import { createPendingSignIn } from '../test-utils/create-pending-sign-in';
import { createTestDatabase } from '../test-utils/create-test-database';
import { runOAuthSignIn } from '../test-utils/run-oauth-sign-in';
import { createMcpAuth } from './create-mcp-auth';

async function setupTest() {
  const database = await createTestDatabase();

  const revocations = createRevocations();

  const tokens = await loadTokenStore({
    db: database.db,
    rootToken: 'a-root-token-of-this-test',
    now: Date.now,
    onRemove: revocations.revoke,
    isFileKey: () => false,
  });

  const log = mock<(message: string) => void>();

  const auth = createMcpAuth({
    db: database.db,
    tokens,
    revocations,
    config: { origin: 'http://127.0.0.1:7171', host: '127.0.0.1:7171', port: 7171 },
    now: Date.now,
    log,
  });

  return {
    db: database.db,
    revocations,
    tokens,
    auth,
    log,

    // the route's OAuth paths, with impd's 404 for any other
    handle: async (request: Request) => {
      const answered = await auth.handle(request);

      return answered ?? new Response('not found', { status: 404 });
    },
  };
}

test('it signs a client in on an approval, and its access token acts within the approval', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: ['dev-*'] });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      handle: ctx.handle,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read exec',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', ['dev-a']);
    },
  );

  const caller = await ctx.auth.resolveAccess(issued.access_token);

  expect(issued.scope).toBe('read exec offline_access');

  expect(caller).toStrictEqual({
    kind: 'oauth',
    name: expect.toStartWith('conn/'),
    scope: 'exec',
    imps: ['dev-a'],
    grantable: [],
    imageRefPrefix: null,
    tokenId: approver.tokenId,
    grantId: expect.toBeString(),
    expiresAt: null,
    principal: expect.toStartWith('grant:'),
    display: 'conn via laptop',
  });
});

test('it refuses an access token past its expiry', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      handle: ctx.handle,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  // the token's 15 minutes ran out a second ago
  await ctx.db
    .updateTable('oauthAccessToken')
    .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    .execute();

  const access = await ctx.auth.resolveAccess(issued.access_token);

  expect(access).toBeNull();
});

test('it refuses a bearer that is no access token it issued', async () => {
  const ctx = await setupTest();
  const access = await ctx.auth.resolveAccess('not-a-token-this-server-issued');

  expect(access).toBeNull();
});

test('it refuses a refresh token sent as the access token', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      handle: ctx.handle,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  const access = await ctx.auth.resolveAccess(issued.refresh_token);

  expect(access).toBeNull();
});

test('it refuses the access token of a removed grant, and ends what the grant opened', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      handle: ctx.handle,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  const caller = await ctx.auth.resolveAccess(issued.access_token);

  invariant(caller?.grantId);

  const ends = ctx.revocations.readSignal(caller.grantId);

  await ctx.auth.removeGrant(caller.grantId);

  const access = await ctx.auth.resolveAccess(issued.access_token);

  expect(access).toBeNull();
  expect(ends?.aborted).toBe(true);
});

test('it ends the grant a removed token approved', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      handle: ctx.handle,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  await ctx.tokens.remove('laptop');

  const access = await ctx.auth.resolveAccess(issued.access_token);
  const grants = await ctx.auth.listGrants();

  expect(access).toBeNull();
  expect(grants).toStrictEqual([]);
});

test('it ends a grant whose approving token no longer holds its scope', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'exec', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      handle: ctx.handle,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'exec',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', undefined);
    },
  );

  // the token's row as an older approval left it: read scope now
  await ctx.db.updateTable('tokens').set({ scope: 'read' }).execute();

  const reloaded = await loadTokenStore({
    db: ctx.db,
    rootToken: 'a-root-token-of-this-test',
    now: Date.now,
    onRemove: ctx.revocations.revoke,
    isFileKey: () => false,
  });

  const narrowed = createMcpAuth({
    db: ctx.db,
    tokens: reloaded,
    revocations: ctx.revocations,
    config: { origin: 'http://127.0.0.1:7171', host: '127.0.0.1:7171', port: 7171 },
    now: Date.now,
    log: () => {},
  });

  const access = await narrowed.resolveAccess(issued.access_token);
  const grants = await narrowed.listGrants();

  expect(access).toBeNull();
  expect(grants).toStrictEqual([]);
});

test('it refreshes a grant’s tokens and refuses its spent refresh token', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      handle: ctx.handle,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  const sendRefresh = () =>
    ctx.handle(
      new Request('http://127.0.0.1:7171/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: client.clientId,
          refresh_token: issued.refresh_token,
        }),
      }),
    );

  const first = await sendRefresh();
  const second = await sendRefresh();

  expect(first.status).toBe(200);
  expect(second.status).toBe(400);
});

test('#listGrants lists a signed-in grant with its client, token, scope and imps', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  await runOAuthSignIn(
    {
      handle: ctx.handle,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'manage',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', ['web-*']);
    },
  );

  const grants = await ctx.auth.listGrants();

  expect(grants).toStrictEqual([
    {
      id: expect.toBeString(),
      client: 'conn',
      token: 'laptop',
      scope: 'exec',
      imps: ['web-*'],
      createdAt: expect.toBeValidDate(),
      lastUsedAt: null,
    },
  ]);
});

test('#removeClient removes the grants its client holds', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      handle: ctx.handle,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  await ctx.auth.removeClient('conn');

  const grants = await ctx.db.selectFrom('user').select('id').execute();
  const access = await ctx.auth.resolveAccess(issued.access_token);

  expect(access).toBeNull();
  expect(grants).toStrictEqual([]);
});

test('#addClient refuses a name another client holds', async () => {
  const ctx = await setupTest();

  await ctx.auth.addClient('conn', ['https://client.example/callback']);

  expect(ctx.auth.addClient('conn', ['https://other.example/callback'])).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test('#addClient refuses one of two adds of the same name that run at once', async () => {
  const ctx = await setupTest();

  const settled = await Promise.allSettled([
    ctx.auth.addClient('conn', ['https://client.example/callback']),
    ctx.auth.addClient('conn', ['https://other.example/callback']),
  ]);

  const clients = await ctx.auth.listClients();

  expect(settled).toIncludeSameMembers([
    { status: 'fulfilled', value: expect.objectContaining({ name: 'conn' }) as unknown },
    { status: 'rejected', reason: expect.objectContaining({ code: 'CONFLICT' }) as unknown },
  ]);

  expect(clients).toHaveLength(1);
});

test('#updateClient replaces the redirect URIs a client holds', async () => {
  const ctx = await setupTest();

  await ctx.auth.addClient('conn', ['https://client.example/callback']);
  await ctx.auth.updateClient('conn', ['https://client.example/next']);

  const clients = await ctx.auth.listClients();

  expect(clients).toStrictEqual([
    {
      name: 'conn',
      clientId: expect.toStartWith('impc_'),
      redirectUris: ['https://client.example/next'],
      createdAt: expect.toBeValidDate(),
    },
  ]);
});

test('#removeExpired removes a grant whose refresh token expired', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  await runOAuthSignIn(
    {
      handle: ctx.handle,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  // a sign-in two hours old whose refresh token ran out
  await ctx.db
    .updateTable('oauthRefreshToken')
    .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    .execute();

  await ctx.db
    .updateTable('user')
    .set({ createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })
    .execute();

  await ctx.auth.removeExpired();

  const grants = await ctx.db.selectFrom('user').select('id').execute();

  expect(grants).toStrictEqual([]);
});

test('#removeExpired never removes a grant with a live refresh token', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  await runOAuthSignIn(
    {
      handle: ctx.handle,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  await ctx.db
    .updateTable('user')
    .set({ createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })
    .execute();

  await ctx.auth.removeExpired();

  const grants = await ctx.db.selectFrom('user').select('id').execute();

  expect(grants).toHaveLength(1);
});

test('it shows the login page again on Continue before the sign-in is approved', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const pending = await createPendingSignIn({
    handle: ctx.handle,
    origin: 'http://127.0.0.1:7171',
    clientID: client.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  const continued = await ctx.handle(
    new Request('http://127.0.0.1:7171/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:7171',
      },
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'continue' }),
    }),
  );

  const page = await continued.text();

  expect(continued.status).toBe(200);
  expect(page).toInclude(`impz oauth approve ${pending.code}`);
});

test('it returns a denied sign-in to the client with access_denied, its state and the issuer', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const pending = await createPendingSignIn({
    handle: ctx.handle,
    origin: 'http://127.0.0.1:7171',
    clientID: client.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  const denied = await ctx.handle(
    new Request('http://127.0.0.1:7171/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:7171',
      },
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'deny' }),
    }),
  );

  const back = new URL(denied.headers.get('location') ?? '');

  expect(`${back.origin}${back.pathname}`).toBe('https://client.example/callback');

  expect(Object.fromEntries(back.searchParams)).toStrictEqual({
    error: 'access_denied',
    error_description: 'the sign-in was denied',
    state: 'st',
    iss: 'http://127.0.0.1:7171',
  });
});

test('it refuses a login form posted from another origin', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const pending = await createPendingSignIn({
    handle: ctx.handle,
    origin: 'http://127.0.0.1:7171',
    clientID: client.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  const posted = await ctx.handle(
    new Request('http://127.0.0.1:7171/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://attacker.example',
      },
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'deny' }),
    }),
  );

  expect(posted.status).toBe(400);
  expect(posted.headers.get('location')).toBeNull();
});

test('it refuses a consent with no session from the sign-in', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const pending = await createPendingSignIn({
    handle: ctx.handle,
    origin: 'http://127.0.0.1:7171',
    clientID: client.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  ctx.auth.approve(ApprovalCodeSchema.parse(pending.code), approver, 'read', undefined);

  const continued = await ctx.handle(
    new Request('http://127.0.0.1:7171/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:7171',
      },
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'continue' }),
    }),
  );

  const consentURL = new URL(continued.headers.get('location') ?? '');

  const consentQuery = consentURL.search.slice(1);

  const allowed = await ctx.handle(
    new Request('http://127.0.0.1:7171/consent', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:7171',
      },
      body: new URLSearchParams({ oauth_query: consentQuery, action: 'allow' }),
    }),
  );

  expect(allowed.status).toBe(400);
  expect(allowed.headers.get('location')).toBeNull();
});

test('it answers a revocation of a token it does not know with an empty 200', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const revoked = await ctx.handle(
    new Request('http://127.0.0.1:7171/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, token: 'no-such-token' }),
    }),
  );

  const body = await revoked.text();

  expect(revoked.status).toBe(200);
  expect(body).toBe('');
});

test('it refuses a token request whose body is past 16 KiB', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const refreshToken = 'r'.repeat(16 * 1024);

  const refused = await ctx.handle(
    new Request('http://127.0.0.1:7171/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: refreshToken,
      }),
    }),
  );

  const body: unknown = await refused.json();

  expect(refused.status).toBe(400);

  expect(body).toStrictEqual({
    error: 'invalid_request',
    error_description: 'the request body is missing or too large',
  });
});

test('it refuses a revocation whose body is past 16 KiB', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const token = 't'.repeat(16 * 1024);

  const refused = await ctx.handle(
    new Request('http://127.0.0.1:7171/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, token }),
    }),
  );

  expect(refused.status).toBe(400);
});

test('it shows a sign-in for a client it does not know a page that says so', async () => {
  const ctx = await setupTest();

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: 'impc_unknown',
    redirect_uri: 'https://client.example/callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  });

  const authorized = await ctx.handle(
    new Request(`http://127.0.0.1:7171/oauth2/authorize?${query.toString()}`),
  );

  const errorURL = new URL(authorized.headers.get('location') ?? '', 'http://127.0.0.1:7171');

  const page = await ctx.handle(new Request(errorURL.href));
  const text = await page.text();

  expect(errorURL.pathname).toBe('/error');
  expect(page.status).toBe(400);
  expect(text).toInclude('This client is not one this host knows.');
});

test('it signs a client in on a clock of impd’s own that is not the wall clock', async () => {
  const ctx = await setupTest();

  const frozen = createMcpAuth({
    db: ctx.db,
    tokens: ctx.tokens,
    revocations: ctx.revocations,
    config: { origin: 'http://127.0.0.1:7171', host: '127.0.0.1:7171', port: 7171 },
    now: () => Date.UTC(2026, 0, 1),
    log: () => {},
  });

  const client = await frozen.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      handle: async (request) => {
        const answered = await frozen.handle(request);

        return answered ?? new Response('not found', { status: 404 });
      },
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      frozen.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  expect(issued.scope).toBe('read offline_access');
});

test('it answers no path while the route is off', async () => {
  const ctx = await setupTest();

  const off = createMcpAuth({
    db: ctx.db,
    tokens: ctx.tokens,
    revocations: ctx.revocations,
    config: null,
    now: Date.now,
    log: () => {},
  });

  const answered = await off.handle(
    new Request('http://127.0.0.1/.well-known/oauth-authorization-server'),
  );

  expect(answered).toBeNull();
});
