import { expect, onTestFinished, test } from 'bun:test';
import { connect } from 'node:net';
import { startStubBrokerPlainUpstream } from './start-stub-broker-plain-upstream';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return { stack };
}

test('it answers a request through its handler', async () => {
  const ctx = setupTest();

  const upstream = startStubBrokerPlainUpstream(ctx.stack, (request) =>
    Response.json({ path: new URL(request.url).pathname }),
  );

  const response = await fetch(`${upstream.origin}/v1/ping`);
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ path: '/v1/ping' });
});

test('it hands its handler the Host header the client put on the wire', async () => {
  const ctx = setupTest();
  const hosts: (string | null)[] = [];

  const upstream = startStubBrokerPlainUpstream(ctx.stack, (request) => {
    hosts.push(request.headers.get('host'));

    return new Response('ok');
  });

  const closed = Promise.withResolvers<void>();
  const socket = connect({ host: '127.0.0.1', port: upstream.port });

  ctx.stack.defer(() => {
    socket.destroy();
  });

  socket.on('data', () => {});

  socket.once('close', () => {
    closed.resolve();
  });

  socket.write('GET / HTTP/1.1\r\nHost: named.test:81\r\nConnection: close\r\n\r\n');

  await closed.promise;

  expect(hosts).toStrictEqual(['named.test:81']);
});
