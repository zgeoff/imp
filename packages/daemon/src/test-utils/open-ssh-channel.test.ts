import { expect, test } from 'bun:test';
import { openSshChannel } from './open-ssh-channel';
import { openSshClient } from './open-ssh-client';
import { startStubSshServer } from './start-stub-ssh-server';

// An SSH server on loopback and a client logged in to it. The server answers
// each exec with the test's `server.exec.answer` and refuses every forward.
async function setupTest() {
  // the client needs the server's one password to log in
  const server = await startStubSshServer({ password: 'secret' });

  const client = await openSshClient({
    host: '127.0.0.1',
    port: server.port,
    username: 'dev',
    password: 'secret',
  });

  return { server, client };
}

test('it collects a channel’s output and exit status from the open on', async () => {
  const ctx = await setupTest();

  ctx.server.exec.answer = (channel) => {
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

  ctx.server.exec.answer = (channel) => {
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
