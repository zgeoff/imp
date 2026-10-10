import { expect, onTestFinished, test } from 'bun:test';
import { Server } from 'ssh2';
import type { ServerChannel } from 'ssh2';
import { z } from 'zod';
import { createEd25519Key } from '../ssh/host-key';
import { openSshChannel } from './open-ssh-channel';
import { openSshClient } from './open-ssh-client';

// An ssh2 server on loopback that takes any login and answers every exec
// with the test's `script.answer`, in the same packet burst as the open. It
// takes no forward, so a forward's open fails.
async function setupTest() {
  const script: { answer: (channel: ServerChannel) => void } = { answer: () => {} };

  const server = new Server({ hostKeys: [createEd25519Key().private] }, (client) => {
    client.on('authentication', (auth) => {
      auth.accept();
    });

    client.on('error', () => {});

    client.on('session', (acceptSession) => {
      const session = acceptSession();

      session.on('exec', (acceptExec) => {
        script.answer(acceptExec());
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

  // a server listening on a TCP port reports an object with its port
  const address = z.object({ port: z.number() }).parse(server.address());

  const client = await openSshClient({
    host: '127.0.0.1',
    port: address.port,
    username: 'dev',
    password: 'any',
  });

  return { client, script };
}

test('it collects a channel’s output and exit status from the open on', async () => {
  const ctx = await setupTest();

  ctx.script.answer = (channel) => {
    channel.write('out');
    channel.stderr.write('err');
    channel.exit(3);
    channel.end();
  };

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

test('it collects the signal a program was killed by', async () => {
  const ctx = await setupTest();

  ctx.script.answer = (channel) => {
    channel.exit('TERM', false, '');
    channel.end();
  };

  const opened = await openSshChannel((done) => {
    ctx.client.exec('sleep 60', done);
  });

  const result = await opened.result;

  expect(result).toStrictEqual({
    stdout: '',
    stderr: '',
    code: null,

    // ssh2's client names the signal as node does
    signal: 'SIGTERM',
  });
});

test('it rejects with the open’s failure', async () => {
  const ctx = await setupTest();

  const opened = openSshChannel((done) => {
    ctx.client.forwardOut('127.0.0.1', 50_000, '127.0.0.1', 80, done);
  });

  expect(opened).rejects.toThrowWithMessage(Error, '(SSH) Channel open failure: ');
});
