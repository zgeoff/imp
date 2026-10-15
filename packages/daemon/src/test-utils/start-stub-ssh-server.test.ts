import { expect, onTestFinished, test } from 'bun:test';
import { createConnection } from 'node:net';
import { waitFor } from '@impz/test-utils/wait-for';
import { Client } from 'ssh2';
import { startStubSshServer } from './start-stub-ssh-server';

test('it accepts a login with its password', async () => {
  const server = await startStubSshServer({ password: 'secret' });

  const client = new Client();

  onTestFinished(() => {
    client.end();
  });

  const ready = Promise.withResolvers<void>();

  client.once('ready', ready.resolve);
  client.on('error', ready.reject);
  client.connect({ host: '127.0.0.1', port: server.port, username: 'dev', password: 'secret' });

  expect(ready.promise).resolves.toBeUndefined();
});

test('it refuses a login with another password', async () => {
  const server = await startStubSshServer({ password: 'secret' });

  const client = new Client();

  onTestFinished(() => {
    client.end();
  });

  const ready = Promise.withResolvers<void>();

  client.once('ready', ready.resolve);

  // `on`: a refused client can emit a second error after the first
  client.on('error', ready.reject);
  client.connect({ host: '127.0.0.1', port: server.port, username: 'dev', password: 'wrong' });

  expect(ready.promise).rejects.toThrowWithMessage(
    Error,
    'All configured authentication methods failed',
  );
});

test('it answers an exec with the test’s answer', async () => {
  const server = await startStubSshServer({ password: 'secret' });

  const client = new Client();

  onTestFinished(() => {
    client.end();
  });

  const ready = Promise.withResolvers<void>();

  client.once('ready', ready.resolve);
  client.on('error', ready.reject);
  client.connect({ host: '127.0.0.1', port: server.port, username: 'dev', password: 'secret' });

  await ready.promise;

  server.exec.answer = (channel) => {
    channel.write('out');
    channel.exit(3);
    channel.end();
  };

  const seen: { stdout: string; code: number | null } = { stdout: '', code: null };
  const closed = Promise.withResolvers<void>();

  // listens from the open on: the answer comes in the open's packet burst
  client.exec('true', (_failure, channel) => {
    channel.on('data', (data: Buffer) => {
      seen.stdout += data.toString();
    });

    channel.on('exit', (code: number | null) => {
      seen.code = code;
    });

    channel.on('close', closed.resolve);
  });

  await closed.promise;

  expect(seen).toStrictEqual({ stdout: 'out', code: 3 });
});

test('it refuses a forward', async () => {
  const server = await startStubSshServer({ password: 'secret' });

  const client = new Client();

  onTestFinished(() => {
    client.end();
  });

  const ready = Promise.withResolvers<void>();

  client.once('ready', ready.resolve);
  client.on('error', ready.reject);
  client.connect({ host: '127.0.0.1', port: server.port, username: 'dev', password: 'secret' });

  await ready.promise;

  const opened = Promise.withResolvers<Readonly<Error> | undefined>();

  client.forwardOut('127.0.0.1', 50_000, '127.0.0.1', 80, opened.resolve);

  const failure = await opened.promise;

  expect(failure?.message).toBe('(SSH) Channel open failure: ');
});

test('it counts a connection that closes', async () => {
  const server = await startStubSshServer({ password: 'secret' });

  const client = new Client();

  onTestFinished(() => {
    client.end();
  });

  const ready = Promise.withResolvers<void>();

  client.once('ready', ready.resolve);
  client.on('error', ready.reject);
  client.connect({ host: '127.0.0.1', port: server.port, username: 'dev', password: 'secret' });

  await ready.promise;

  client.end();

  await waitFor(() => {
    expect(server.closes.count).toBe(1);
  });
});

test('it stops listening when the test finishes', async () => {
  const server = await startStubSshServer({ password: 'secret' });

  // runs after the stand-in's own release
  onTestFinished(() => {
    const refused = Promise.withResolvers<void>();
    const socket = createConnection(server.port, '127.0.0.1');

    socket.once('connect', () => {
      socket.destroy();
      refused.resolve();
    });

    socket.once('error', refused.reject);

    expect(refused.promise).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
