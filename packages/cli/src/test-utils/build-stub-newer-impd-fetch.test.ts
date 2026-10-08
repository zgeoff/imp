import { expect, test } from 'bun:test';
import { buildStubNewerImpdFetch } from './build-stub-newer-impd-fetch';

test('it adds the named fields to each item of a list answer and keeps the rest', async () => {
  const fetch = buildStubNewerImpdFetch(
    () =>
      Promise.resolve(
        Response.json({ json: [{ name: 'web' }, { name: 'db' }], meta: [[1, 0, 'createdAt']] }),
      ),
    { withFields: { 'imps/list': { host: 'peer' } } },
  );

  const response = await fetch(new Request('http://impd.test/rpc/imps/list', { method: 'POST' }));
  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    json: [
      { name: 'web', host: 'peer' },
      { name: 'db', host: 'peer' },
    ],
    meta: [[1, 0, 'createdAt']],
  });
});

test('it adds the named fields to an object answer', async () => {
  const fetch = buildStubNewerImpdFetch(
    () => Promise.resolve(Response.json({ json: { name: 'web' }, meta: [] })),
    { withFields: { 'imps/get': { host: 'peer' } } },
  );

  const response = await fetch(
    new Request('http://impd.test/base/rpc/imps/get', { method: 'POST' }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ json: { name: 'web', host: 'peer' }, meta: [] });
});

test('it passes the answer of another procedure as it came', async () => {
  const answer = Response.json({ json: [{ name: 'web' }] });

  const fetch = buildStubNewerImpdFetch(() => Promise.resolve(answer), {
    withFields: { 'imps/list': { host: 'peer' } },
  });

  const response = await fetch(new Request('http://impd.test/rpc/images/list', { method: 'POST' }));

  expect(response).toBe(answer);
});

test('it passes a failed answer as it came', async () => {
  const answer = Response.json({ json: { code: 'UNAUTHORIZED' } }, { status: 401 });

  const fetch = buildStubNewerImpdFetch(() => Promise.resolve(answer), {
    withFields: { 'imps/list': { host: 'peer' } },
  });

  const response = await fetch(new Request('http://impd.test/rpc/imps/list', { method: 'POST' }));

  expect(response).toBe(answer);
});
