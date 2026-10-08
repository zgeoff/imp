import { expect, onTestFinished, test } from 'bun:test';
import { startStubSilentHost } from './start-stub-silent-host';

test('it takes a request and never answers it', () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const host = startStubSilentHost(stack);

  const answer = fetch(`${host.url}/rpc/imps/list`, {
    method: 'POST',
    signal: AbortSignal.timeout(200),
  });

  expect(answer).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(host.requests).toStrictEqual(['/rpc/imps/list']);
});

test('it stops listening once the stack is released', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const host = startStubSilentHost(stack);

  await stack.disposeAsync();

  expect(fetch(`${host.url}/rpc/imps/list`, { method: 'POST' })).rejects.toThrow();
});
