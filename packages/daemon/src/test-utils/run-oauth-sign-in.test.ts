import { expect, test } from 'bun:test';
import { ApprovalCodeSchema } from '@impz/api';
import { invariant } from '@impz/test-utils/invariant';
import { createRevocations } from '../auth/revocations';
import { loadTokenStore } from '../auth/token-store';
import { createMcpAuth } from '../oauth/create-mcp-auth';
import { createTestDatabase } from './create-test-database';
import { runOAuthSignIn } from './run-oauth-sign-in';

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

  const auth = createMcpAuth({
    db: database.db,
    tokens,
    revocations,
    config: { origin: 'http://127.0.0.1:7171', host: '127.0.0.1:7171', port: 7171 },
    now: Date.now,
    log: () => {},
  });

  return {
    auth,
    tokens,
    handle: async (request: Request) => {
      const answered = await auth.handle(request);

      return answered ?? new Response('not found', { status: 404 });
    },
  };
}

test('it signs a client in to tokens for the approved scope', async () => {
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
      scope: 'manage',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', undefined);
    },
  );

  expect(issued).toStrictEqual({
    access_token: expect.toBeString(),
    refresh_token: expect.toBeString(),
    scope: 'read exec offline_access',
  });
});

test('it throws, naming Continue, when nothing approves the sign-in', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  expect(
    runOAuthSignIn(
      {
        handle: ctx.handle,
        origin: 'http://127.0.0.1:7171',
        clientID: client.clientId,
        redirectURI: 'https://client.example/callback',
        scope: 'read',
      },
      () => {},
    ),
  ).rejects.toThrowWithMessage(Error, /^Continue answered 200/);
});
