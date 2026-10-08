import { expect, onTestFinished, test } from 'bun:test';
import { createServer } from 'node:net';
import { findFreePorts } from './find-free-ports';
import { startStubBrokerTunnel } from './start-stub-broker-tunnel';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // a front port that answers each CONNECT with the reply the test sets
  const state = { reply: 'HTTP/1.1 200 Connection Established\r\n\r\n', heads: [] as string[] };

  const front = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data: (socket, data) => {
        state.heads.push(data.toString());
        socket.write(state.reply);
      },
    },
  });

  stack.defer(() => {
    front.stop(true);
  });

  return { stack, front, state };
}

test('it sends nothing until the head is sent', async () => {
  const ctx = setupTest();

  // a front that ends its side at once but reads on: the guest's side ends
  // in turn, after any bytes it sent on connect
  const heard: string[] = [];
  const hungUp = Promise.withResolvers<void>();

  const front = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('data', (chunk: Buffer) => {
      heard.push(chunk.toString());
    });

    socket.once('end', () => {
      hungUp.resolve();
    });

    socket.end();
  });

  const port = findFreePorts(1).take();
  const listening = Promise.withResolvers<void>();

  front.listen(port, '127.0.0.1', listening.resolve);

  await listening.promise;

  ctx.stack.defer(() => {
    front.close();
  });

  await startStubBrokerTunnel(ctx.stack, {
    proxyPort: port,
    address: '127.0.0.2',
    target: 'a.test:443',
  });

  await hungUp.promise;

  expect(heard).toStrictEqual([]);
});

test('it sends a CONNECT head for its target', async () => {
  const ctx = setupTest();

  const tunnel = await startStubBrokerTunnel(ctx.stack, {
    proxyPort: ctx.front.port,
    address: '127.0.0.2',
    target: 'a.test:443',
  });

  tunnel.sendHead();

  await tunnel.established;

  expect(ctx.state.heads).toStrictEqual([
    'CONNECT a.test:443 HTTP/1.1\r\nHost: a.test:443\r\n\r\n',
  ]);
});

test('it rejects established with the reply when the front refuses', async () => {
  const ctx = setupTest();

  ctx.state.reply = 'HTTP/1.1 403 Forbidden\r\n\r\nno\n';

  const tunnel = await startStubBrokerTunnel(ctx.stack, {
    proxyPort: ctx.front.port,
    address: '127.0.0.2',
    target: 'a.test:443',
  });

  tunnel.sendHead();

  expect(tunnel.established).rejects.toThrow('HTTP/1.1 403 Forbidden');
});

test('it reports closed once the front ends the connection', async () => {
  const ctx = setupTest();

  const tunnel = await startStubBrokerTunnel(ctx.stack, {
    proxyPort: ctx.front.port,
    address: '127.0.0.2',
    target: 'a.test:443',
  });

  tunnel.sendHead();

  await tunnel.established;

  ctx.front.stop(true);

  await tunnel.closed;

  expect(tunnel.isOpen()).toBeFalse();
});

test('it stays open while the front holds the connection', async () => {
  const ctx = setupTest();

  const tunnel = await startStubBrokerTunnel(ctx.stack, {
    proxyPort: ctx.front.port,
    address: '127.0.0.2',
    target: 'a.test:443',
  });

  tunnel.sendHead();

  await tunnel.established;

  expect(tunnel.isOpen()).toBeTrue();
});
