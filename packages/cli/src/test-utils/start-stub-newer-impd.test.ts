import { expect, onTestFinished, test } from 'bun:test';
import { startStubNewerImpd } from './start-stub-newer-impd';

test('it serves the newer answers on a loopback port', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const newer = startStubNewerImpd(
    stack,
    () => Promise.resolve(Response.json({ json: [{ name: 'web' }], meta: [] })),
    { withFields: { 'imps/list': { host: 'peer' } } },
  );

  const response = await fetch(`${newer.url}/rpc/imps/list`, { method: 'POST' });
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ json: [{ name: 'web', host: 'peer' }], meta: [] });
});

test('it stops listening once the stack is released', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const newer = startStubNewerImpd(stack, () => Promise.resolve(new Response('{}')), {
    withFields: {},
  });

  await stack.disposeAsync();

  expect(fetch(`${newer.url}/rpc/imps/list`, { method: 'POST' })).rejects.toThrow();
});
