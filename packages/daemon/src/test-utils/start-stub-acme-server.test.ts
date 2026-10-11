import { expect, onTestFinished, test } from 'bun:test';
import * as acme from 'acme-client';
import { startStubAcmeServer } from './start-stub-acme-server';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return { stack };
}

test('it serves a directory that names the nonce, account and order URLs', async () => {
  const ctx = setupTest();
  const server = startStubAcmeServer(ctx.stack, { challengeTypes: ['dns-01'] });

  const response = await fetch(server.directoryUrl);
  const directory: unknown = await response.json();

  const origin = new URL(server.directoryUrl).origin;

  expect(directory).toStrictEqual({
    newNonce: `${origin}/new-nonce`,
    newAccount: `${origin}/new-account`,
    newOrder: `${origin}/new-order`,
  });
});

test('it gives acme-client an account, an order and an authorization for each name', async () => {
  const ctx = setupTest();
  const server = startStubAcmeServer(ctx.stack, { challengeTypes: ['http-01', 'dns-01'] });

  const origin = new URL(server.directoryUrl).origin;

  const client = new acme.Client({
    directoryUrl: server.directoryUrl,
    accountKey: await acme.crypto.createPrivateEcdsaKey(),
  });

  await client.createAccount({ termsOfServiceAgreed: true });

  const order = await client.createOrder({
    identifiers: [
      { type: 'dns', value: 'imp.test' },
      { type: 'dns', value: '*.imp.test' },
    ],
  });

  const authorizations = await client.getAuthorizations(order);

  expect(client.getAccountUrl()).toBe(`${origin}/account/1`);

  expect(authorizations).toStrictEqual([
    {
      url: `${origin}/authz/1/0`,
      status: 'pending',
      identifier: { type: 'dns', value: 'imp.test' },
      challenges: [
        { type: 'http-01', status: 'pending', url: `${origin}/challenge/1/0/0`, token: 'token-0' },
        { type: 'dns-01', status: 'pending', url: `${origin}/challenge/1/0/1`, token: 'token-1' },
      ],
    },
    {
      url: `${origin}/authz/1/1`,
      status: 'pending',
      identifier: { type: 'dns', value: 'imp.test' },
      wildcard: true,
      challenges: [
        { type: 'http-01', status: 'pending', url: `${origin}/challenge/1/1/0`, token: 'token-0' },
        { type: 'dns-01', status: 'pending', url: `${origin}/challenge/1/1/1`, token: 'token-1' },
      ],
    },
  ]);

  expect(server.unexpected).toStrictEqual([]);
});

test('it answers a call it does not model with a 500 that names it, and records it', async () => {
  const ctx = setupTest();
  const server = startStubAcmeServer(ctx.stack, { challengeTypes: ['dns-01'] });

  const origin = new URL(server.directoryUrl).origin;

  const response = await fetch(`${origin}/finalize/1`, { method: 'POST' });
  const body = await response.text();

  expect(response.status).toBe(500);
  expect(body).toBe('the stub ACME server does not model POST /finalize/1');
  expect(server.unexpected).toStrictEqual(['POST /finalize/1']);
});
