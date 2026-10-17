import { expect, test } from 'bun:test';
import { createRevocations } from '../auth/revocations';
import { loadTokenStore } from '../auth/token-store';
import { createMcpAuth } from '../oauth/create-mcp-auth';
import { createPendingSignIn } from './create-pending-sign-in';
import { createTestDatabase } from './create-test-database';

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
    handle: async (request: Request) => {
      const answered = await auth.handle(request);

      return answered ?? new Response('not found', { status: 404 });
    },
  };
}

test('it starts a sign-in and reads its approval code from the login page', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const pending = await createPendingSignIn({
    handle: ctx.handle,
    origin: 'http://127.0.0.1:7171',
    clientID: client.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  expect(pending).toStrictEqual({
    code: expect.toSatisfy((code: string) => /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/v.test(code)),
    oauthQuery: expect.toInclude(`client_id=${client.clientId}`),
  });
});

test('it throws, naming authorize, for a client the route does not know', async () => {
  const ctx = await setupTest();

  expect(
    createPendingSignIn({
      handle: ctx.handle,
      origin: 'http://127.0.0.1:7171',
      clientID: 'impc_unknown',
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    }),
  ).rejects.toThrowWithMessage(Error, /^authorize answered/u);
});
