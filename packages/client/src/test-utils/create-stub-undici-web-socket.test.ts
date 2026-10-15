import { expect, mock, onTestFinished, test } from 'bun:test';
import { waitFor } from '@impz/test-utils/wait-for';
import { createStubUndiciWebSocket } from './create-stub-undici-web-socket';

test('it fires error and no close listener for a refused upgrade', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('unauthorized', { status: 401 }),
    websocket: { message: () => {} },
  });

  onTestFinished(() => server.stop(true));

  const errors = mock<() => void>();
  const closes = mock<() => void>();
  const closed = Promise.withResolvers<void>();
  const socket = createStubUndiciWebSocket(`ws://127.0.0.1:${String(server.port)}/`);

  socket.addEventListener('error', errors);
  socket.addEventListener('close', closes);

  // the real close, which listeners added through addEventListener miss
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- see above
  socket.onclose = () => {
    closed.resolve();
  };

  await closed.promise;

  expect(errors).toHaveBeenCalledOnce();
  expect(closes).not.toHaveBeenCalled();
});

test('it passes open and message listeners through for an accepted upgrade', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, bunServer) =>
      bunServer.upgrade(request) ? undefined : new Response('not a socket', { status: 400 }),
    websocket: {
      open: (ws) => {
        ws.send('hello');
      },
      message: () => {},
    },
  });

  onTestFinished(() => server.stop(true));

  const opens = mock<() => void>();
  const messages: unknown[] = [];
  const socket = createStubUndiciWebSocket(`ws://127.0.0.1:${String(server.port)}/`);

  socket.addEventListener('open', opens);

  socket.addEventListener('message', (event: MessageEvent) => {
    messages.push(event.data);
  });

  await waitFor(() => {
    expect(messages).toStrictEqual(['hello']);
  });

  expect(opens).toHaveBeenCalledOnce();
});

test('it closes the socket when the test ends', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, bunServer) =>
      bunServer.upgrade(request) ? undefined : new Response('not a socket', { status: 400 }),
    websocket: { message: () => {} },
  });

  onTestFinished(() => server.stop(true));

  const opened = Promise.withResolvers<void>();
  const socket = createStubUndiciWebSocket(`ws://127.0.0.1:${String(server.port)}/`);

  onTestFinished(() => {
    expect(socket.readyState).toBeOneOf([WebSocket.CLOSING, WebSocket.CLOSED]);
  });

  socket.addEventListener('open', () => {
    opened.resolve();
  });

  await opened.promise;

  expect(socket.readyState).toBe(WebSocket.OPEN);
});
