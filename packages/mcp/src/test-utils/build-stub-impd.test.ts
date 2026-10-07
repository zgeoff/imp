import { expect, test } from 'bun:test';
import { impContract } from '@imp/api';
import { buildMockImp } from '@imp/api/test-utils/build-mock-imp';
import { server } from '@imp/test-utils/mock-server';
import { implement } from '@orpc/server';
import { createImpClient } from '@zgeoff/imp-client';
import { buildStubImpd } from './build-stub-impd';

test('it answers a procedure its router holds as impd encodes it', async () => {
  const imp = buildMockImp({ name: 'dev-a', createdAt: new Date('2026-01-02T03:04:05.000Z') });
  const impd = implement(impContract);
  const client = createImpClient({ url: 'http://impd.test', token: 'test-token' });

  server.use(
    buildStubImpd('http://impd.test', { imps: { list: impd.imps.list.handler(() => [imp]) } }),
  );

  const imps = await client.imps.list();

  expect(imps).toStrictEqual([imp]);
});

test('it answers 404 for a procedure its router lacks', async () => {
  const impd = implement(impContract);

  server.use(
    buildStubImpd('http://impd.test', { imps: { list: impd.imps.list.handler(() => []) } }),
  );

  const response = await fetch('http://impd.test/rpc/images/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  expect(response.status).toBe(404);
});
