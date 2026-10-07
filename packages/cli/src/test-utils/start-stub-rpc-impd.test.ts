import { expect, test } from 'bun:test';
import { ORPCError } from '@orpc/client';
import { createImpClient } from '../create-imp-client';
import { startStubRpcImpd } from './start-stub-rpc-impd';

test('it answers a procedure from its table, dates and all', async () => {
  using impd = startStubRpcImpd({
    token: 'stub-token',
    answers: { 'images/list': [{ name: 'base', createdAt: new Date('2026-10-03T00:00:00.000Z') }] },
  });

  const images: unknown = await createImpClient({
    url: impd.url,
    token: 'stub-token',
  }).images.list();

  expect(images).toStrictEqual([{ name: 'base', createdAt: new Date('2026-10-03T00:00:00.000Z') }]);
});

test('it answers null for a procedure its table leaves out', async () => {
  using impd = startStubRpcImpd({ token: 'stub-token' });

  const info: unknown = await createImpClient({ url: impd.url, token: 'stub-token' }).system.info();

  expect(info).toBeNull();
});

test('it records the path, the token and the decoded input of each call', async () => {
  using impd = startStubRpcImpd({ token: 'stub-token', answers: { 'imps/list': [] } });

  await createImpClient({ url: impd.url, token: 'stub-token' }).imps.list({ builders: true });

  expect(impd.calls).toStrictEqual([
    { path: 'imps/list', authorization: 'Bearer stub-token', input: { builders: true } },
  ]);
});

test('it refuses another token with impd’s 401 and still records the call', () => {
  using impd = startStubRpcImpd({ token: 'stub-token' });

  const info = createImpClient({ url: impd.url, token: 'other-token' }).system.info();

  expect(info).rejects.toMatchObject({ status: 401 });

  expect(impd.calls).toStrictEqual([
    { path: 'system/info', authorization: 'Bearer other-token', input: undefined },
  ]);
});

test('it fails a procedure with the oRPC error its table names', () => {
  using impd = startStubRpcImpd({
    token: 'stub-token',
    failures: {
      'imps/create': {
        defined: true,
        code: 'RAM_BUDGET_EXCEEDED',
        status: 503,
        message: 'Not enough RAM budget',
        data: { budgetMib: 8192, usedMib: 8000, requestedMib: 512 },
      },
    },
  });

  const created = createImpClient({ url: impd.url, token: 'stub-token' }).imps.create({
    name: 'dev',
  });

  expect(created).rejects.toBeInstanceOf(ORPCError);

  expect(created).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    status: 503,
    message: 'Not enough RAM budget',
    data: { budgetMib: 8192, usedMib: 8000, requestedMib: 512 },
  });
});

test('it never answers when it is silent', () => {
  using impd = startStubRpcImpd({ token: 'stub-token', isSilent: true });

  const answer = fetch(`${impd.url}/rpc/system/info`, { signal: AbortSignal.timeout(50) });

  expect(answer).rejects.toThrowWithMessage(DOMException, /timed out/u);
  expect(impd.calls).toStrictEqual([]);
});
