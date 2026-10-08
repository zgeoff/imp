import { expect, onTestFinished, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { startStubTunnelFaultProxy } from './start-stub-tunnel-fault-proxy';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // the target: answers HTTP with its path, echoes each WebSocket text as
  // `echo <text>`, and closes a WebSocket that sends `drop` without a frame
  const target = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request) ? undefined : new Response(new URL(request.url).pathname),
    websocket: {
      message: (ws, data) => {
        if (data === 'drop') {
          ws.terminate();

          return;
        }

        ws.send(`echo ${String(data)}`);
      },
    },
  });

  stack.defer(async () => {
    await target.stop(true);
  });

  const proxy = startStubTunnelFaultProxy(stack, `http://127.0.0.1:${String(target.port)}`);

  return { stack, proxy };
}

test('it relays an HTTP request to the target', async () => {
  const ctx = setupTest();

  const response = await fetch(`${ctx.proxy.url}/rpc/system/info`, { method: 'POST' });
  const body = await response.text();

  expect(body).toBe('/rpc/system/info');
});

test('it relays WebSocket text both ways and records what went to the client', async () => {
  const ctx = setupTest();

  const ws = new WebSocket(`${ctx.proxy.url.replace('http:', 'ws:')}/tunnel`);

  ctx.stack.defer(() => {
    ws.close();
  });

  const received: string[] = [];

  ws.addEventListener('message', (event) => {
    received.push(String(event.data));
  });

  ws.addEventListener('open', () => {
    ws.send('hello');
  });

  await waitFor(() => {
    expect(received).toStrictEqual(['echo hello']);
  });

  expect(ctx.proxy.tunnels).toStrictEqual([{ toClient: ['echo hello'], isClosed: false }]);
});

test('it sends a fault text to the named WebSocket only', async () => {
  const ctx = setupTest();

  const first = new WebSocket(`${ctx.proxy.url.replace('http:', 'ws:')}/tunnel`);
  const second = new WebSocket(`${ctx.proxy.url.replace('http:', 'ws:')}/tunnel`);

  ctx.stack.defer(() => {
    first.close();
    second.close();
  });

  const toFirst: string[] = [];
  const toSecond: string[] = [];

  first.addEventListener('message', (event) => {
    toFirst.push(String(event.data));
  });

  second.addEventListener('message', (event) => {
    toSecond.push(String(event.data));
  });

  await waitFor(() => {
    expect(ctx.proxy.tunnels).toHaveLength(2);
  });

  ctx.proxy.sendText(1, 'not json');

  await waitFor(() => {
    expect(toSecond).toStrictEqual(['not json']);
  });

  expect(toFirst).toBeEmpty();
});

test('it refuses a fault for a WebSocket that never opened', () => {
  const ctx = setupTest();

  expect(() => {
    ctx.proxy.sendText(0, 'not json');
  }).toThrowWithMessage(Error, 'no WebSocket 0 has opened');
});

test('it drops the client without a close frame when the target drops its side', async () => {
  const ctx = setupTest();

  const ws = new WebSocket(`${ctx.proxy.url.replace('http:', 'ws:')}/tunnel`);

  const closed = Promise.withResolvers<number>();

  ws.addEventListener('close', (event) => {
    closed.resolve(event.code);
  });

  ws.addEventListener('open', () => {
    ws.send('drop');
  });

  const code = await closed.promise;

  expect(code).toBe(1006);
});

test('it stops listening once the stack is released', async () => {
  const ctx = setupTest();

  await ctx.stack.disposeAsync();

  expect(fetch(`${ctx.proxy.url}/rpc/system/info`, { method: 'POST' })).rejects.toThrow();
});
