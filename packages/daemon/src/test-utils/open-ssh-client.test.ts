import { expect, onTestFinished, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { Client, Server } from 'ssh2';
import { createEd25519Key } from '../ssh/host-key';
import { openSshClient } from './open-ssh-client';

// An ssh2 server on loopback that takes the password `secret` and counts
// the connections that close.
async function setupTest() {
  const closes = { count: 0 };

  const server = new Server({ hostKeys: [createEd25519Key().private] }, (client) => {
    client.on('authentication', (auth) => {
      const isRight = auth.method === 'password' && auth.password === 'secret';

      if (isRight) {
        auth.accept();
      } else {
        auth.reject(['password']);
      }
    });

    client.on('error', () => {});

    client.on('close', () => {
      closes.count += 1;
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  // stops listening; the client's own end closes its connection
  onTestFinished(() => {
    server.close();
  });

  const address = server.address();

  if (typeof address !== 'object' || address === null) {
    throw new TypeError('the server has no TCP address');
  }

  return { port: address.port, closes };
}

test('it resolves with a client logged in to the server', async () => {
  const ctx = await setupTest();

  const client = await openSshClient({
    host: '127.0.0.1',
    port: ctx.port,
    username: 'dev',
    password: 'secret',
  });

  expect(client).toBeInstanceOf(Client);
});

test('it rejects with the client’s error when the server refuses the login', async () => {
  const ctx = await setupTest();

  const login = openSshClient({
    host: '127.0.0.1',
    port: ctx.port,
    username: 'dev',
    password: 'wrong',
  });

  expect(login).rejects.toThrowWithMessage(Error, 'All configured authentication methods failed');
});

test('it ends the client when the test finishes', async () => {
  const ctx = await setupTest();

  await openSshClient({ host: '127.0.0.1', port: ctx.port, username: 'dev', password: 'secret' });

  // runs after the client's own end; the server sees the connection close
  onTestFinished(async () => {
    await waitFor(() => {
      expect(ctx.closes.count).toBe(1);
    });
  });
});
