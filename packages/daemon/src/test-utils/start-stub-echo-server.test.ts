import { expect, onTestFinished, test } from 'bun:test';
import { createConnection } from 'node:net';
import { startStubEchoServer } from './start-stub-echo-server';

test('it echoes what a connection sends', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const server = await startStubEchoServer(stack);

  const echoed = Promise.withResolvers<string>();

  const client = createConnection({ host: '127.0.0.1', port: server.port }, () => {
    client.write('hello');
  });

  stack.defer(() => {
    client.destroy();
  });

  client.once('data', (chunk: Buffer) => {
    echoed.resolve(chunk.toString());
  });

  const echo = await echoed.promise;

  expect(echo).toBe('hello');
});

test('it holds a connection open until its release', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const server = await startStubEchoServer(stack);

  const connected = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const client = createConnection({ host: '127.0.0.1', port: server.port }, connected.resolve);

  onTestFinished(() => {
    client.destroy();
  });

  client.on('error', () => {});

  client.once('close', () => {
    closed.resolve();
  });

  await connected.promise;

  // an echo proves the server still holds the connection before the release
  const echoed = Promise.withResolvers<void>();

  client.once('data', () => {
    echoed.resolve();
  });

  client.write('ping');

  await echoed.promise;

  const openBefore = !client.destroyed;

  await stack.disposeAsync();

  await closed.promise;

  expect(openBefore).toBeTrue();
  expect(client.destroyed).toBeTrue();
});

test('it refuses connections once released', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const server = await startStubEchoServer(stack);

  await stack.disposeAsync();

  const failed = Promise.withResolvers<unknown>();
  const client = createConnection({ host: '127.0.0.1', port: server.port });

  onTestFinished(() => {
    client.destroy();
  });

  client.once('error', failed.resolve);

  const error = await failed.promise;

  expect(error).toMatchObject({ code: 'ECONNREFUSED' });
});
