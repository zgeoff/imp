import { expect, onTestFinished, test } from 'bun:test';
import { connect } from 'node:net';
import { startStubBrokerReplyTarget } from './start-stub-broker-reply-target';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return { stack };
}

test('it answers a request head with a 200 that carries its body, then closes', async () => {
  const ctx = setupTest();

  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  const chunks: Buffer[] = [];
  const closed = Promise.withResolvers<void>();
  const socket = connect({ host: '127.0.0.1', port: target.port });

  ctx.stack.defer(() => {
    socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  socket.once('close', () => {
    closed.resolve();
  });

  socket.write('GET / HTTP/1.1\r\nHost: plain.test\r\n\r\n');

  await closed.promise;

  expect(Buffer.concat(chunks).toString()).toBe(
    'HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\n\r\ntunnel',
  );
});

test('it records a request head that arrives in pieces as one', async () => {
  const ctx = setupTest();

  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  const closed = Promise.withResolvers<void>();
  const socket = connect({ host: '127.0.0.1', port: target.port });

  ctx.stack.defer(() => {
    socket.destroy();
  });

  socket.on('data', () => {});

  socket.once('close', () => {
    closed.resolve();
  });

  socket.write('GET / HTTP/1.1\r\n');

  // the second piece goes only once the first has left
  await new Promise<void>((resolve) => {
    socket.write('Host: plain.test\r\n\r\n', () => {
      resolve();
    });
  });

  await closed.promise;

  expect(target.received).toStrictEqual(['GET / HTTP/1.1\r\nHost: plain.test\r\n\r\n']);
});

test('it answers nothing before the request head ends', async () => {
  const ctx = setupTest();

  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  const chunks: Buffer[] = [];
  const closed = Promise.withResolvers<void>();
  const socket = connect({ host: '127.0.0.1', port: target.port });

  ctx.stack.defer(() => {
    socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  socket.once('close', () => {
    closed.resolve();
  });

  // the client ends its side mid-head; a target that answered on connect or
  // on any bytes would still have sent its reply
  socket.end('GET / HTTP/1.1\r\n');

  await closed.promise;

  expect(Buffer.concat(chunks).toString()).toBe('');
});
