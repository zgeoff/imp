import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { startStubSshAgent } from './start-stub-ssh-agent';

test('it answers each request with agent: and the request', async () => {
  const agent = await startStubSshAgent({ mode: 'answer' });

  const answered = Promise.withResolvers<string>();

  const socket = createConnection(agent.path, () => {
    socket.write('list');
  });

  onTestFinished(() => {
    socket.destroy();
  });

  socket.once('data', (data: Buffer) => {
    answered.resolve(data.toString());
  });

  const answer = await answered.promise;

  expect(answer).toBe('agent:list');
});

test('it listens on a socket in a dir of its own', async () => {
  const agent = await startStubSshAgent({ mode: 'hold' });

  expect(agent.path).toEndWith('/agent.sock');
  expect(dirname(agent.path)).toMatch(/\/imp-agent-[^\/]+$/v);
});

test('it ends a held connection when the test finishes', async () => {
  const agent = await startStubSshAgent({ mode: 'hold' });

  const connected = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const socket = createConnection(agent.path, connected.resolve);

  socket.on('error', () => {});
  socket.once('close', closed.resolve);
  socket.resume();

  await connected.promise;

  // runs after the stand-in's own release
  onTestFinished(async () => {
    await closed.promise;

    expect(socket.destroyed).toBeTrue();
  });
});

test('it removes its socket dir when the test finishes', async () => {
  const agent = await startStubSshAgent({ mode: 'answer' });

  // runs after the stand-in's own release
  onTestFinished(() => {
    expect(existsSync(dirname(agent.path))).toBeFalse();
  });
});
