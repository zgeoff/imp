import { expect, onTestFinished, test } from 'bun:test';
import { buildStubCongestedSocket } from './build-stub-congested-socket';

test('it reports the queued bytes the test sets as its buffered amount', () => {
  const ws = new WebSocket('ws://127.0.0.1:1/exec');

  onTestFinished(() => {
    ws.close();
  });

  const stub = buildStubCongestedSocket(ws);

  stub.queued.bytes = 2048;

  expect(stub.socket.bufferedAmount).toBe(2048);
});

test('it sends through the real socket', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const received = Promise.withResolvers<string>();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, bunServer) =>
      bunServer.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 }),
    websocket: {
      message: (_ws, data) => {
        received.resolve(String(data));
      },
    },
  });

  stack.defer(async () => {
    await server.stop(true);
  });

  const stub = buildStubCongestedSocket(
    new WebSocket(`ws://127.0.0.1:${String(server.port)}/exec`),
  );

  stack.defer(() => {
    stub.socket.close();
  });

  stub.socket.addEventListener('open', () => {
    stub.socket.send(JSON.stringify({ type: 'stdin_eof' }));
  });

  const text = await received.promise;

  expect(text).toBe('{"type":"stdin_eof"}');
});

test('it sets the binary type on the real socket', () => {
  const ws = new WebSocket('ws://127.0.0.1:1/exec');

  onTestFinished(() => {
    ws.close();
  });

  const stub = buildStubCongestedSocket(ws);

  stub.socket.binaryType = 'arraybuffer';

  expect(ws.binaryType).toBe('arraybuffer');
});
