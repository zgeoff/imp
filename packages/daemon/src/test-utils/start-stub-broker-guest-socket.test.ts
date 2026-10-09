import { expect, onTestFinished, test } from 'bun:test';
import type { Socket } from 'bun';
import { findFreePorts } from './find-free-ports';
import { startStubBrokerGuestSocket } from './start-stub-broker-guest-socket';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // the broker's front port: it hands over the first connection and the
  // first bytes that arrive on it
  const accepted = Promise.withResolvers<Socket>();
  const received = Promise.withResolvers<string>();

  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (socket) => {
        accepted.resolve(socket);
      },
      data: (_socket, data) => {
        received.resolve(data.toString());
      },
    },
  });

  stack.defer(() => {
    server.stop(true);
  });

  return { stack, port: server.port, accepted: accepted.promise, received: received.promise };
}

test('it connects from the guest address it is given', async () => {
  const ctx = setupTest();

  await startStubBrokerGuestSocket(ctx.stack, { port: ctx.port, address: '127.0.0.2' });

  const socket = await ctx.accepted;

  expect(socket.remoteAddress).toBe('127.0.0.2');
});

test('it resolves the reply with every byte sent before the close', async () => {
  const ctx = setupTest();

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: ctx.port,
    address: '127.0.0.2',
  });

  const socket = await ctx.accepted;

  socket.write('first ');
  socket.end('second');

  expect(guest.reply).resolves.toBe('first second');
});

test('it sends what the test writes', async () => {
  const ctx = setupTest();

  const guest = await startStubBrokerGuestSocket(ctx.stack, {
    port: ctx.port,
    address: '127.0.0.2',
  });

  guest.write('CONNECT a.test:443 HTTP/1.1\r\n\r\n');

  expect(ctx.received).resolves.toBe('CONNECT a.test:443 HTTP/1.1\r\n\r\n');
});

test('it rejects when nothing listens on the port', () => {
  const ctx = setupTest();

  expect(
    startStubBrokerGuestSocket(ctx.stack, { port: findFreePorts(1).take(), address: '127.0.0.2' }),
  ).rejects.toThrow();
});
