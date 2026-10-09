import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDialStream } from '@imp/daemon/src/agent-client/dial-stream';
import { openAccept, openListener } from '@imp/daemon/src/agent-client/listener-stream';
import { startStubAgent } from '@imp/daemon/src/test-utils/start-stub-agent';
import { buildStubForwardAgent } from './build-stub-forward-agent';

// the stub on a socket in a temp dir, as impd's agent client reaches it
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'stub-forward-agent-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const agent = buildStubForwardAgent();
  const vsockPath = join(dir, 'v.sock');

  const server = await startStubAgent(vsockPath, agent.readFrame);

  stack.defer(() => {
    server.close();
  });

  return { agent, vsockPath };
}

test('it listens on the unix socket a listen names', async () => {
  const ctx = await setupTest();
  const listener = await openListener(ctx.vsockPath, { network: 'unix', path: '/tmp/app.sock' });

  onTestFinished(() => {
    listener.close();
  });

  expect({ id: listener.id, path: listener.path, port: listener.port }).toStrictEqual({
    id: 'fwd1',
    path: '/tmp/app.sock',
    port: null,
  });
});

test('it makes its own socket for a listen with no path', async () => {
  const ctx = await setupTest();
  const listener = await openListener(ctx.vsockPath, { network: 'unix', path: null });

  onTestFinished(() => {
    listener.close();
  });

  expect(listener.path).toBe('/run/imp/forward/1.sock');
});

test('it listens on port 4000 for a tcp listen', async () => {
  const ctx = await setupTest();
  const listener = await openListener(ctx.vsockPath, { network: 'tcp', port: 0 });

  onTestFinished(() => {
    listener.close();
  });

  expect({ path: listener.path, port: listener.port }).toStrictEqual({ path: null, port: 4000 });
});

test('it refuses every listen after refuseListens with its error', async () => {
  const ctx = await setupTest();

  ctx.agent.refuseListens({ code: 'LISTEN_FAILED', message: 'address in use' });

  expect(
    openListener(ctx.vsockPath, { network: 'unix', path: '/tmp/app.sock' }),
  ).rejects.toMatchObject({ code: 'LISTEN_FAILED', detail: 'address in use' });
});

test('it sends a waiting client to the newest listener', async () => {
  const ctx = await setupTest();
  const older = await openListener(ctx.vsockPath, { network: 'unix', path: '/tmp/a.sock' });
  const newest = await openListener(ctx.vsockPath, { network: 'unix', path: '/tmp/b.sock' });

  ctx.agent.connect(3);
  ctx.agent.endListeners();

  const [olderConnections, newestConnections] = await Promise.all([
    Array.fromAsync(older.connections()),
    Array.fromAsync(newest.connections()),
  ]);

  expect(olderConnections).toStrictEqual([]);
  expect(newestConnections).toStrictEqual([3]);
});

test('it ends every listener on endListeners', async () => {
  const ctx = await setupTest();
  const first = await openListener(ctx.vsockPath, { network: 'unix', path: '/tmp/a.sock' });
  const second = await openListener(ctx.vsockPath, { network: 'unix', path: '/tmp/b.sock' });

  ctx.agent.endListeners();

  const [firstConnections, secondConnections] = await Promise.all([
    Array.fromAsync(first.connections()),
    Array.fromAsync(second.connections()),
  ]);

  expect(firstConnections).toStrictEqual([]);
  expect(secondConnections).toStrictEqual([]);
});

test('it answers an accepted client with got and the bytes, then closes its side', async () => {
  const ctx = await setupTest();
  const stream = await openAccept(ctx.vsockPath, 'fwd1', 3);

  stream.write(new TextEncoder().encode('hello'));
  stream.end();

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'data', data: new TextEncoder().encode('got hello') },
    { type: 'eof' },
  ]);
});

test('it records each request in its wire form', async () => {
  const ctx = await setupTest();
  const listener = await openListener(ctx.vsockPath, { network: 'unix', path: '/tmp/app.sock' });

  listener.close();

  const stream = await openAccept(ctx.vsockPath, 'fwd1', 3);

  stream.close();

  expect(ctx.agent.requests).toStrictEqual([
    { op: 'listen', network: 'unix', address: '/tmp/app.sock' },
    { op: 'agent.accept', listener: 'fwd1', connection: 3 },
  ]);
});

test('it refuses an op it does not know, as an agent from before it does', async () => {
  const ctx = await setupTest();

  expect(
    openDialStream(ctx.vsockPath, { network: 'tcp', address: '127.0.0.1:22' }),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
});
