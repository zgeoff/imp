import { expect, mock, onTestFinished, test } from 'bun:test';
import { startStubInfoFaultImpd } from './start-stub-info-fault-impd';

test('it drops the connection of a system.info call before any answer', () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const inner = mock<(request: Request) => Promise<Response>>(() =>
    Promise.resolve(new Response('{}')),
  );

  const impd = startStubInfoFaultImpd(stack, inner);
  const answer = fetch(`${impd.url}/rpc/system/info`, { method: 'POST' });

  expect(answer).rejects.toThrow();
  expect(inner).not.toHaveBeenCalled();
  expect(impd.calls).toStrictEqual(['system/info']);
});

test('it passes every other call to the app behind it', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const impd = startStubInfoFaultImpd(stack, (request) =>
    Promise.resolve(new Response(new URL(request.url).pathname)),
  );

  const response = await fetch(`${impd.url}/rpc/tokens/create`, { method: 'POST' });
  const text = await response.text();

  expect(text).toBe('/rpc/tokens/create');
  expect(impd.calls).toStrictEqual(['tokens/create']);
});

test('it stops listening once the stack is released', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const impd = startStubInfoFaultImpd(stack, () => Promise.resolve(new Response('{}')));

  await stack.disposeAsync();

  expect(fetch(`${impd.url}/rpc/tokens/list`, { method: 'POST' })).rejects.toThrow();
});
