import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { startStubAgent } from '../test-utils/start-stub-agent';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from './frame-codec';
import { openAccept, openListener } from './listener-stream';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-agentfwd-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { vsockPath: join(dir, 'vsock.sock') };
}

test('#openListener asks the agent for an ssh-agent socket', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        ok: true,
        path: '/run/imp/ssh-agent/ab/agent.sock',
        listener: 'ab',
      }),
    );
  });

  await openListener(ctx.vsockPath, { network: 'ssh-agent' });

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({ op: 'agent.listen' });
});

test('#openListener answers with its socket, then names each client', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(
      encodeJsonFrame(FRAME_TYPES.response, {
        ok: true,
        path: '/run/imp/ssh-agent/ab/agent.sock',
        listener: 'ab',
      }),
    );

    socket.write(encodeJsonFrame(FRAME_TYPES.connection, { id: 1 }));
    socket.end(encodeJsonFrame(FRAME_TYPES.connection, { id: 2 }));
  });

  const listener = await openListener(ctx.vsockPath, { network: 'ssh-agent' });
  const ids = await Array.fromAsync(listener.connections());

  expect(listener).toMatchObject({
    path: '/run/imp/ssh-agent/ab/agent.sock',
    port: null,
    id: 'ab',
  });

  expect(ids).toStrictEqual([1, 2]);
});

test('#openListener rejects with AGENT_OUTDATED for an agent from before agent forwarding', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op agent.listen' },
      }),
    );
  });

  expect(openListener(ctx.vsockPath, { network: 'ssh-agent' })).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
    detail: "the imp's agent has no ssh-agent forwarding yet; stop and start the imp to update it",
  });
});

test('#openListener listens on a port the agent picks', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.response, { ok: true, port: 41_000, listener: 'cd' }));
  });

  const listener = await openListener(ctx.vsockPath, { network: 'tcp', port: 0 });

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'listen',
    network: 'tcp',
    address: '127.0.0.1:0',
  });

  expect(listener).toMatchObject({ port: 41_000, path: null, id: 'cd' });
});

test('#openListener listens on a socket the agent makes for a null path', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        ok: true,
        path: '/run/imp/forward/cd/sock',
        listener: 'cd',
      }),
    );
  });

  const listener = await openListener(ctx.vsockPath, { network: 'unix', path: null });

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'listen',
    network: 'unix',
    address: '',
  });

  expect(listener).toMatchObject({ port: null, path: '/run/imp/forward/cd/sock', id: 'cd' });
});

test('#openListener listens on the socket path it is given', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, { ok: true, path: '/tmp/atc.sock', listener: 'cd' }),
    );
  });

  await openListener(ctx.vsockPath, { network: 'unix', path: '/tmp/atc.sock' });

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'listen',
    network: 'unix',
    address: '/tmp/atc.sock',
  });
});

test('#openListener rejects with AGENT_OUTDATED for an agent from before reverse forwards', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op listen' },
      }),
    );
  });

  expect(openListener(ctx.vsockPath, { network: 'tcp', port: 0 })).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
    detail: "the imp's agent has no reverse forwards yet; stop and start the imp to update it",
  });
});

test('#openListener rejects when the agent closes the connection before it answers', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end();
  });

  expect(openListener(ctx.vsockPath, { network: 'ssh-agent' })).rejects.toThrowWithMessage(
    Error,
    'agent closed the listen connection before it answered',
  );
});

test('#openAccept names its listener and client', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
  });

  const stream = await openAccept(ctx.vsockPath, 'ab', 7);

  stream.close();

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'agent.accept',
    listener: 'ab',
    connection: 7,
  });
});

test('#openAccept rejects with NO_CONNECTION for a client that is gone', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'NO_CONNECTION', message: 'no waiting connection 7' },
      }),
    );
  });

  expect(openAccept(ctx.vsockPath, 'ab', 7)).rejects.toMatchObject({
    code: 'NO_CONNECTION',
    detail: 'no waiting connection 7',
  });
});
