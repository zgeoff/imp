import { expect, test } from 'bun:test';
import type { ImpContract } from '@imp/api';
import { ORPCError, createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { buildApp } from './build-app';
import { loadConfig } from './config';
import { openDatabase } from './db/open-database';

const TOKEN = 'test-token';

async function setupTest(token: string) {
  const db = await openDatabase(':memory:');

  const app = buildApp({ config: loadConfig({}), db, token: TOKEN });

  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: { authorization: `Bearer ${token}` },
    fetch: (request) => app.handle(request),
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(link);

  return {
    app,
    client,
    [Symbol.asyncDispose]: () => db.destroy(),
  };
}

test('it serves system.info from config and the database', async () => {
  await using ctx = await setupTest(TOKEN);

  const info = await ctx.client.system.info();

  expect(info).toEqual({
    version: '0.0.0',
    ramBudgetMib: 16_384,
    ramUsedMib: 0,
    awakeCount: 0,
    impCount: 0,
    firecrackerVersion: null,
    tailscale: { enabled: false, state: null, hostname: null },
  });
});

test('it answers an unbuilt procedure with NOT_IMPLEMENTED', async () => {
  await using ctx = await setupTest(TOKEN);

  const rejection = await ctx.client.imps.list().catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(ORPCError);
  expect(rejection).toMatchObject({ code: 'NOT_IMPLEMENTED', status: 501 });
});

test('it rejects a request with the wrong token', async () => {
  await using ctx = await setupTest('wrong');

  const rejection = await ctx.client.system.info().catch((error: unknown) => error);

  expect(rejection).toMatchObject({ status: 401 });
});

test('it answers /health without a token', async () => {
  await using ctx = await setupTest(TOKEN);

  const response = await ctx.app.handle(new Request('http://impd.test/health'));
  const body: unknown = await response.json();

  expect(body).toEqual({ status: 'ok' });
});
