import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDialStream } from '@impz/daemon/src/agent-client/dial-stream';
import { openAccept, openListener } from '@impz/daemon/src/agent-client/listener-stream';
import { startStubAgent } from '@impz/daemon/src/test-utils/start-stub-agent';
import { invariant } from '@impz/test-utils/invariant';
import { buildStubListenAgent } from './build-stub-listen-agent';

// a socket path in a temp dir, as impd's agent client reaches the stub there
async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-listen-agent-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { vsockPath: join(dir, 'v.sock') };
}

test('it answers a listen with the port it was given', async () => {
  const ctx = await setupTest();

  const agent = buildStubListenAgent({ listening: { port: 9000 } });

  await startStubAgent(ctx.vsockPath, agent.readFrame);

  const listener = await openListener(ctx.vsockPath, { network: 'tcp', port: 9000 });

  onTestFinished(() => {
    listener.close();
  });

  expect({ id: listener.id, path: listener.path, port: listener.port }).toStrictEqual({
    id: 'fwd1',
    path: null,
    port: 9000,
  });
});

test('it answers a listen with the socket path it was given', async () => {
  const ctx = await setupTest();

  const agent = buildStubListenAgent({ listening: { path: '/run/imp/fwd1.sock' } });

  await startStubAgent(ctx.vsockPath, agent.readFrame);

  const listener = await openListener(ctx.vsockPath, { network: 'unix', path: null });

  onTestFinished(() => {
    listener.close();
  });

  expect({ id: listener.id, path: listener.path, port: listener.port }).toStrictEqual({
    id: 'fwd1',
    path: '/run/imp/fwd1.sock',
    port: null,
  });
});

test('it names each listen in turn and keeps it open until the test ends it', async () => {
  const ctx = await setupTest();

  const agent = buildStubListenAgent({ listening: { port: 9000 } });

  await startStubAgent(ctx.vsockPath, agent.readFrame);

  const first = await openListener(ctx.vsockPath, { network: 'tcp', port: 9000 });
  const second = await openListener(ctx.vsockPath, { network: 'tcp', port: 9000 });

  onTestFinished(() => {
    first.close();
    second.close();
  });

  const [listen] = agent.listens;

  invariant(listen);

  listen.end();

  const connections = await Array.fromAsync(first.connections());

  expect(second.id).toBe('fwd2');
  expect(connections).toStrictEqual([]);
  expect(agent.listens).toHaveLength(2);
});

test('it has one client waiting on each listen when clientSends is set', async () => {
  const ctx = await setupTest();

  const agent = buildStubListenAgent({ listening: { port: 9000 }, clientSends: 'hello' });

  await startStubAgent(ctx.vsockPath, agent.readFrame);

  const listener = await openListener(ctx.vsockPath, { network: 'tcp', port: 9000 });

  onTestFinished(() => {
    listener.close();
  });

  const [listen] = agent.listens;

  invariant(listen);

  listen.end();

  const connections = await Array.fromAsync(listener.connections());

  expect(connections).toStrictEqual([1]);
});

test('it sends an accepted client’s bytes and closes once the forward’s side closes', async () => {
  const ctx = await setupTest();

  const agent = buildStubListenAgent({ listening: { port: 9000 }, clientSends: 'hello' });

  await startStubAgent(ctx.vsockPath, agent.readFrame);

  const stream = await openAccept(ctx.vsockPath, 'fwd1', 1);

  onTestFinished(() => {
    stream.close();
  });

  stream.end();

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'data', data: new TextEncoder().encode('hello') },
    { type: 'eof' },
  ]);
});

test('it refuses each listen after refuseListens with its error', async () => {
  const ctx = await setupTest();

  const agent = buildStubListenAgent({ listening: { port: 9000 } });

  await startStubAgent(ctx.vsockPath, agent.readFrame);

  agent.refuseListens({ code: 'LISTEN_FAILED', message: 'port 9000 is in use in the imp' });

  expect(openListener(ctx.vsockPath, { network: 'tcp', port: 9000 })).rejects.toMatchObject({
    code: 'LISTEN_FAILED',
    detail: 'port 9000 is in use in the imp',
  });
});

test('it ends a call of another op without an answer', async () => {
  const ctx = await setupTest();

  const agent = buildStubListenAgent({ listening: { port: 9000 } });

  await startStubAgent(ctx.vsockPath, agent.readFrame);

  expect(
    openDialStream(ctx.vsockPath, { network: 'tcp', address: '127.0.0.1:22' }),
  ).rejects.toThrowWithMessage(Error, 'agent closed the dial connection before it answered');
});
