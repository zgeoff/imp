import { expect, test } from 'bun:test';
import { buildStubOlderImpdFetch } from './build-stub-older-impd-fetch';

test('it takes the grant report out of a fork’s answer and keeps the rest', async () => {
  const fetch = buildStubOlderImpdFetch(() =>
    Promise.resolve(
      Response.json({
        json: { name: 'dev-b', grantsNotCopied: [{ secret: 'gh', reason: 'not-grantable' }] },
        meta: [[1, 'createdAt']],
      }),
    ),
  );

  const response = await fetch(new Request('http://impd.test/rpc/imps/fork', { method: 'POST' }));
  const body: unknown = await response.json();

  expect(response.status).toBe(200);

  expect(body).toStrictEqual({
    json: { name: 'dev-b' },
    meta: [[1, 'createdAt']],
  });
});

test('it takes the grant error out of a fork’s answer and keeps the rest', async () => {
  const fetch = buildStubOlderImpdFetch(() =>
    Promise.resolve(
      Response.json({
        json: { name: 'dev-b', grantsNotCopied: [], grantsError: 'the copy failed' },
      }),
    ),
  );

  const response = await fetch(new Request('http://impd.test/rpc/imps/fork', { method: 'POST' }));
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ json: { name: 'dev-b' } });
});

test('it passes the answer of another procedure as it came', async () => {
  const answer = Response.json({ json: { grantsNotCopied: [] } });
  const fetch = buildStubOlderImpdFetch(() => Promise.resolve(answer));

  const response = await fetch(new Request('http://impd.test/rpc/imps/list', { method: 'POST' }));

  expect(response).toBe(answer);
});

test('it passes a failed fork’s answer as it came', async () => {
  const answer = Response.json({ json: { code: 'NOT_FOUND' } }, { status: 404 });
  const fetch = buildStubOlderImpdFetch(() => Promise.resolve(answer));

  const response = await fetch(new Request('http://impd.test/rpc/imps/fork', { method: 'POST' }));

  expect(response).toBe(answer);
});
