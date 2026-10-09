import { expect, onTestFinished, test } from 'bun:test';
import { Server } from 'ssh2';
import { createEd25519Key } from '../ssh/host-key';
import { openSshChannel } from './open-ssh-channel';
import { openSshClient } from './open-ssh-client';

// An ssh2 server on loopback that takes any login and answers every exec in
// the same packet burst as the open: stdout `out`, stderr `err`, exit 3. It
// takes no forward, so a forward's open fails.
async function setupTest() {
  const server = new Server({ hostKeys: [createEd25519Key().private] }, (client) => {
    client.on('authentication', (auth) => {
      auth.accept();
    });

    client.on('error', () => {});

    client.on('session', (acceptSession) => {
      const session = acceptSession();

      session.on('exec', (acceptExec) => {
        const channel = acceptExec();

        channel.write('out');
        channel.stderr.write('err');
        channel.exit(3);
        channel.end();
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  // stops listening; each client's own end closes its connection
  onTestFinished(() => {
    server.close();
  });

  const address = server.address();

  if (typeof address !== 'object' || address === null) {
    throw new TypeError('the server has no TCP address');
  }

  const client = await openSshClient({
    host: '127.0.0.1',
    port: address.port,
    username: 'dev',
    password: 'any',
  });

  return { client };
}

test('it collects a channel’s output and exit status from the open on', async () => {
  const ctx = await setupTest();

  const opened = await openSshChannel((done) => {
    ctx.client.exec('true', done);
  });

  const result = await opened.result;

  expect(result).toStrictEqual({
    stdout: 'out',
    stderr: 'err',
    code: 3,
    signal: null,
  });
});

test('it rejects with the open’s failure', async () => {
  const ctx = await setupTest();

  const opened = openSshChannel((done) => {
    ctx.client.forwardOut('127.0.0.1', 50_000, '127.0.0.1', 80, done);
  });

  expect(opened).rejects.toThrow();
});
