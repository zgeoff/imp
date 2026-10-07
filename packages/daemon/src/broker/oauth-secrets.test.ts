import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSecret } from '../db/secrets';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { createBroker } from './broker-service';
import type { OAuthRequest } from './oauth-refresher';
import { createSecretFiles } from './secret-files';

// An oauth secret through the API: the token endpoint is a function and every
// token is made up (docs/guides/connectors.md#oauth-secrets).

const OAUTH = {
  tokenUrl: 'https://auth.example.com/oauth/token',
  clientId: 'fake-client',
  tokenFormat: 'json' as const,
};

const RULES = [{ host: 'api.example.com', header: 'authorization', scheme: 'bearer' as const }];

type Reply = () => Response | Promise<Response>;

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function buildJwt(claims: Readonly<Record<string, unknown>>): string {
  return `${encodeSegment({ alg: 'none' })}.${encodeSegment(claims)}.fake`;
}

function buildReply(status: number, body: unknown): Reply {
  return () => Response.json(body, { status });
}

async function setupTest() {
  const calls: { readonly body: string; readonly rowExists: boolean }[] = [];
  const replies: Reply[] = [];
  const hold = { gate: null as Promise<void> | null };
  const seen: { db: Awaited<ReturnType<typeof setupImpTest>>['db'] | null } = { db: null };

  const harness = await setupImpTest({
    oauthFetch: async (_url: string, init: OAuthRequest) => {
      const row = seen.db === null ? undefined : await findSecret(seen.db, 'codex');

      calls.push({ body: init.body, rowExists: row !== undefined });

      if (hold.gate !== null) {
        await hold.gate;
      }

      const next = replies.shift();

      if (next === undefined) {
        throw new Error('no reply queued');
      }

      return next();
    },
  });

  seen.db = harness.db;

  await harness.createTestImage('base');

  const ctx = { ...harness, ...buildTestApp(harness, harness) };

  const readValueFile = async (name: string): Promise<string> => {
    const secret = await findSecret(ctx.db, name);

    return readFileSync(join(ctx.dataDir, 'secrets', secret?.valueFile ?? 'none'), 'utf8');
  };

  return { ...ctx, calls, replies, hold, readValueFile };
}

function setOAuth(
  ctx: Readonly<Pick<Awaited<ReturnType<typeof setupTest>>, 'client'>>,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: RULES,
    oauth: OAUTH,
    ...overrides,
  });
}

test('an oauth secret signs in after its row is committed, and the API shows no token', async () => {
  await using ctx = await setupTest();

  const claims = {
    email: 'someone@example.com',
    sub: 'fake-subject',
    at_hash: 'x',
    c_hash: 'x',
    nonce: 'x',
    sid: 'x',
    jti: 'x',
  };

  ctx.replies.push(
    buildReply(200, {
      access_token: 'fake-access-1',
      refresh_token: 'fake-refresh-1',
      id_token: buildJwt(claims),
      expires_in: 3600,
    }),
  );

  const added = await setOAuth(ctx);

  // the call came after the commit, so a failed commit could not lose a rotated token
  expect(ctx.calls).toEqual([
    {
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: 'fake-refresh-0',
        client_id: 'fake-client',
      }),
      rowExists: true,
    },
  ]);

  expect(added).toMatchObject({
    name: 'codex',
    kind: 'oauth',
    droppedGrants: 0,
    oauth: {
      ...OAUTH,
      status: 'ready',
      error: null,
      idClaims: { email: 'someone@example.com', sub: 'fake-subject' },
    },
  });

  expect(added.oauth?.expiresAt).toBeInstanceOf(Date);
  expect(added.oauth?.idClaims).not.toHaveProperty('jti');
  expect(added.oauth?.idClaims).not.toHaveProperty('nonce');

  const listed = await ctx.client.secrets.list();

  expect(listed[0]?.oauth?.status).toBe('ready');

  const everything = JSON.stringify([
    added,
    listed,
    await ctx.client.system.info(),
    await ctx.client.audit.list({}),
    await ctx.client.audit.calls({}),
  ]);

  expect(everything).not.toMatch(/fake-(?:access|refresh)/);
  expect(everything).not.toContain(buildJwt(claims));

  // the value file holds the state, with the rotated token
  const stored = await ctx.readValueFile('codex');

  expect(JSON.parse(stored)).toMatchObject({
    v: 1,
    refreshToken: 'fake-refresh-1',
    accessToken: 'fake-access-1',
  });
});

test('a first refresh that fails still answers, pending or needing a new sign-in', async () => {
  await using ctx = await setupTest();

  ctx.replies.push(buildReply(503, { error: 'unavailable' }));

  const pending = await setOAuth(ctx);

  expect(pending.oauth).toMatchObject({ status: 'pending', error: 'HTTP 503', expiresAt: null });

  ctx.replies.push(buildReply(400, { error: 'invalid_grant' }));

  const dead = await setOAuth(ctx, { replace: true });

  expect(dead.oauth).toMatchObject({ status: 'needs_login', error: 'invalid_grant' });

  const listed = await ctx.client.secrets.list();

  expect(listed[0]?.oauth?.status).toBe('needs_login');
});

test('the oauth config belongs to kind oauth, and the kind needs it and its hosts', async () => {
  await using ctx = await setupTest();

  const refused = await Promise.all(
    [
      setOAuth(ctx, { oauth: undefined }),
      setOAuth(ctx, { rules: undefined }),
      ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'x', oauth: OAUTH }),
      ctx.client.secrets.add({
        name: 'api',
        kind: 'custom',
        value: 'x',
        rules: RULES,
        oauth: OAUTH,
      }),
      setOAuth(ctx, { oauth: { ...OAUTH, tokenUrl: 'http://auth.example.com/token' } }),
      setOAuth(ctx, { oauth: { ...OAUTH, clientId: 'has space' } }),
      setOAuth(ctx, { oauth: { ...OAUTH, tokenFormat: 'xml' } }),
    ].map((call) => call.catch((error: unknown) => error)),
  );

  for (const failure of refused) {
    expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
  }

  expect(ctx.calls).toHaveLength(0);

  const none = await ctx.client.secrets.list();

  expect(none).toEqual([]);
});

test('another token URL or client needs a rebind; a new refresh token is a rotation', async () => {
  await using ctx = await setupTest();

  ctx.replies.push(buildReply(200, { access_token: 'fake-access-1', expires_in: 3600 }));

  await setOAuth(ctx);

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.grants.add({ name: 'dev', secret: 'codex' });

  // the same binding with a new refresh token keeps the grant
  ctx.replies.push(buildReply(200, { access_token: 'fake-access-2', expires_in: 3600 }));

  const rotated = await setOAuth(ctx, { value: 'fake-refresh-new', replace: true });

  expect(rotated.droppedGrants).toBe(0);
  expect(ctx.calls[1]?.body).toContain('fake-refresh-new');

  for (const oauth of [
    { ...OAUTH, tokenUrl: 'https://auth.example.org/oauth/token' },
    { ...OAUTH, clientId: 'fake-other' },
    { ...OAUTH, tokenFormat: 'form' as const },
  ]) {
    const failure = await setOAuth(ctx, { oauth, replace: true }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'CONFLICT' });
  }

  ctx.replies.push(buildReply(200, { access_token: 'fake-access-3', expires_in: 3600 }));

  const rebound = await setOAuth(ctx, {
    oauth: { ...OAUTH, clientId: 'fake-other' },
    replace: true,
    rebind: true,
  });

  expect(rebound.droppedGrants).toBe(1);
  expect(rebound.oauth?.clientId).toBe('fake-other');
});

test('secrets.refresh forces a refresh and answers after it; other secrets refuse it', async () => {
  await using ctx = await setupTest();

  ctx.replies.push(
    buildReply(200, {
      access_token: 'fake-access-1',
      refresh_token: 'fake-refresh-1',
      expires_in: 3600,
    }),
    buildReply(200, {
      access_token: 'fake-access-2',
      refresh_token: 'fake-refresh-2',
      expires_in: 3600,
    }),
  );

  await setOAuth(ctx);

  const refreshed = await ctx.client.secrets.refresh({ name: 'codex' });

  expect(refreshed.oauth?.status).toBe('ready');
  expect(ctx.calls[1]?.body).toContain('fake-refresh-1');

  const afterRefresh = await ctx.readValueFile('codex');

  expect(JSON.parse(afterRefresh)).toMatchObject({
    refreshToken: 'fake-refresh-2',
    accessToken: 'fake-access-2',
  });

  // a dead refresh token is answered, not thrown: the status says so
  ctx.replies.push(buildReply(401, {}));

  const dead = await ctx.client.secrets.refresh({ name: 'codex' });

  expect(dead.oauth).toMatchObject({ status: 'needs_login', error: 'HTTP 401' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_x' });

  const other = await ctx.client.secrets.refresh({ name: 'gh' }).catch((error: unknown) => error);

  const missing = await ctx.client.secrets
    .refresh({ name: 'nothing' })
    .catch((error: unknown) => error);

  expect(other).toMatchObject({ code: 'BAD_REQUEST' });
  expect(missing).toMatchObject({ code: 'NOT_FOUND' });
});

test('a replace during a refresh waits for it and is not overwritten by it', async () => {
  await using ctx = await setupTest();

  ctx.replies.push(
    buildReply(200, { access_token: 'fake-access-1', refresh_token: 'fake-refresh-1' }),
  );

  await setOAuth(ctx);

  const gate = Promise.withResolvers<void>();

  ctx.hold.gate = gate.promise;

  ctx.replies.push(
    buildReply(200, { access_token: 'fake-access-2', refresh_token: 'fake-refresh-2' }),
    buildReply(200, { access_token: 'fake-access-3', refresh_token: 'fake-refresh-3' }),
  );

  const refreshing = ctx.client.secrets.refresh({ name: 'codex' });

  while (ctx.calls.length < 2) {
    await Bun.sleep(1);
  }

  const replacing = setOAuth(ctx, { value: 'fake-refresh-replacement', replace: true });

  await Bun.sleep(30);

  // the replace has not written a new file yet
  expect(ctx.calls).toHaveLength(2);

  ctx.hold.gate = null;

  gate.resolve();

  await Promise.all([refreshing, replacing]);

  expect(ctx.calls[2]?.body).toContain('fake-refresh-replacement');

  const afterReplace = await ctx.readValueFile('codex');

  expect(JSON.parse(afterReplace)).toMatchObject({
    refreshToken: 'fake-refresh-3',
    accessToken: 'fake-access-3',
  });
});

test('a delete during a refresh waits for it and then removes the secret and its file', async () => {
  await using ctx = await setupTest();

  ctx.replies.push(buildReply(200, { access_token: 'fake-access-1' }));

  await setOAuth(ctx);

  const gate = Promise.withResolvers<void>();

  ctx.hold.gate = gate.promise;

  ctx.replies.push(
    buildReply(200, { access_token: 'fake-access-2', refresh_token: 'fake-refresh-2' }),
  );

  const refreshing = ctx.client.secrets.refresh({ name: 'codex' });

  while (ctx.calls.length < 2) {
    await Bun.sleep(1);
  }

  const deleting = ctx.client.secrets.delete({ name: 'codex' });

  await Bun.sleep(30);

  const waiting = await findSecret(ctx.db, 'codex');

  expect(waiting).toBeDefined();

  gate.resolve();

  // the refresh ends, then the delete runs, so the refresh finds no secret to answer with
  const refused = await refreshing.catch((error: unknown) => error);

  await deleting;

  expect(refused).toMatchObject({ code: 'NOT_FOUND' });

  const gone = await findSecret(ctx.db, 'codex');
  const listed = await ctx.client.secrets.list();

  expect(gone).toBeUndefined();
  expect(listed).toEqual([]);
});

test('a value file that is gone shows as needing a new sign-in', async () => {
  await using ctx = await setupTest();

  ctx.replies.push(buildReply(200, { access_token: 'fake-access-1' }));

  await setOAuth(ctx);

  const secret = await findSecret(ctx.db, 'codex');

  createSecretFiles(ctx.dataDir).remove(secret?.valueFile ?? '');

  const listed = await ctx.client.secrets.list();

  expect(listed[0]?.oauth).toMatchObject({
    status: 'needs_login',
    error: 'value file missing or unreadable',
  });
});

test('the broker refreshes a secret that is due when it starts', async () => {
  await using ctx = await setupTest();

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: RULES,
    oauth: OAUTH,
  });

  // no answer was queued, so the first sign-in failed and the secret is pending
  expect(ctx.calls).toHaveLength(1);

  const started = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    oauthFetch: (_url, init) => {
      ctx.calls.push({ body: init.body, rowExists: true });

      return Promise.resolve(Response.json({ access_token: 'fake-access-1', expires_in: 3600 }));
    },
  });

  try {
    while (ctx.calls.length < 2) {
      await Bun.sleep(1);
    }

    expect(ctx.calls[1]?.body).toContain('fake-refresh-0');
  } finally {
    await started.stop();
  }
});
