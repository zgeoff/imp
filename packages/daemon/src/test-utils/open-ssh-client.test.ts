import { expect, onTestFinished, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { Client } from 'ssh2';
import { openSshClient } from './open-ssh-client';
import { startStubSshServer } from './start-stub-ssh-server';

test('it resolves with a client logged in to the server', async () => {
  const server = await startStubSshServer({ password: 'secret' });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: server.port,
    username: 'dev',
    password: 'secret',
  });

  expect(client).toBeInstanceOf(Client);
});

test('it rejects with the client’s error when the server refuses the login', async () => {
  const server = await startStubSshServer({ password: 'secret' });

  const login = openSshClient({
    host: '127.0.0.1',
    port: server.port,
    username: 'dev',
    password: 'wrong',
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
});

test('it ends the client when the test finishes', async () => {
  const server = await startStubSshServer({ password: 'secret' });

  await openSshClient({
    host: '127.0.0.1',
    port: server.port,
    username: 'dev',
    password: 'secret',
  });

  // runs after the client's own end; the server sees the connection close
  onTestFinished(async () => {
    await waitFor(() => {
      expect(server.closes.count).toBe(1);
    });
  });
});
