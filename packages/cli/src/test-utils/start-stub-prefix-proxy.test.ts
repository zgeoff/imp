import { expect, mock, onTestFinished, test } from 'bun:test';
import { startStubPrefixProxy } from './start-stub-prefix-proxy';

test('it forwards a request with the prefix taken off', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const target = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) =>
      Response.json({
        path: new URL(request.url).pathname,
        method: request.method,
        body: await request.text(),
      }),
  });

  stack.defer(async () => {
    await target.stop(true);
  });

  const proxy = startStubPrefixProxy(stack, {
    target: `http://127.0.0.1:${String(target.port)}`,
    prefix: '/imp',
  });

  const response = await fetch(`${proxy.url}/rpc/imps/list?x=1`, { method: 'POST', body: 'in' });
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ path: '/rpc/imps/list', method: 'POST', body: 'in' });
  expect(proxy.paths).toStrictEqual(['/imp/rpc/imps/list']);
});

test('it answers 404 for a path outside the prefix and forwards nothing', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const seen = mock<(path: string) => void>();

  const target = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      seen(new URL(request.url).pathname);

      return new Response('ok');
    },
  });

  stack.defer(async () => {
    await target.stop(true);
  });

  const proxy = startStubPrefixProxy(stack, {
    target: `http://127.0.0.1:${String(target.port)}`,
    prefix: '/imp',
  });

  const response = await fetch(`${proxy.url.slice(0, -'/imp'.length)}/rpc/imps/list`);

  expect(response.status).toBe(404);
  expect(seen).not.toHaveBeenCalled();
});

test('it relays a WebSocket under the prefix both ways with its authorization', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const upgrades = mock<(path: string, authorization: string | null) => void>();

  const target = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) => {
      upgrades(new URL(request.url).pathname, request.headers.get('authorization'));

      return server.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
    },
    websocket: {
      message: (ws, data) => {
        const reply = typeof data === 'string' ? `echo ${data}` : data;

        ws.send(reply);
      },
    },
  });

  stack.defer(async () => {
    await target.stop(true);
  });

  const proxy = startStubPrefixProxy(stack, {
    target: `http://127.0.0.1:${String(target.port)}`,
    prefix: '/imp',
  });

  const ws = new WebSocket(`${proxy.url.replace('http', 'ws')}/exec`, {
    headers: { authorization: 'Bearer token' },
  });

  stack.defer(() => {
    ws.close();
  });

  ws.binaryType = 'arraybuffer';

  const replies: unknown[] = [];
  const both = Promise.withResolvers<void>();

  ws.addEventListener('message', (event) => {
    replies.push(event.data);

    if (replies.length === 2) {
      both.resolve();
    }
  });

  ws.addEventListener('open', () => {
    ws.send('hello');
    ws.send(new Uint8Array([1, 2]));
  });

  await both.promise;

  expect(replies).toStrictEqual(['echo hello', new Uint8Array([1, 2]).buffer]);
  expect(upgrades).toHaveBeenCalledExactlyOnceWith('/exec', 'Bearer token');
});

test('it closes the client’s WebSocket with the target’s code and reason', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const target = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 }),
    websocket: {
      open: (ws) => {
        ws.close(1011, 'agent gone');
      },
      message: () => {},
    },
  });

  stack.defer(async () => {
    await target.stop(true);
  });

  const proxy = startStubPrefixProxy(stack, {
    target: `http://127.0.0.1:${String(target.port)}`,
    prefix: '/imp',
  });

  const ws = new WebSocket(`${proxy.url.replace('http', 'ws')}/exec`);

  const closing = Promise.withResolvers<CloseEvent>();

  ws.addEventListener('close', (event) => {
    closing.resolve(event);
  });

  const event = await closing.promise;

  expect(event.code).toBe(1011);
  expect(event.reason).toBe('agent gone');
});

test('it stops listening once the stack is released', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const proxy = startStubPrefixProxy(stack, { target: 'http://127.0.0.1:1', prefix: '/imp' });

  await stack.disposeAsync();

  expect(fetch(`${proxy.url}/rpc/imps/list`)).rejects.toThrow();
});
