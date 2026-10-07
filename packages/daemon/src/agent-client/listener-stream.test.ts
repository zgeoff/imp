import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRejection } from '../read-rejection';
import { startStubAgent } from '../test-utils/start-stub-agent';
import type { StubAgentHandler } from '../test-utils/start-stub-agent';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from './frame-codec';
import { openAccept, openListener } from './listener-stream';

const LISTENING = { ok: true, path: '/run/imp/ssh-agent/ab/agent.sock', listener: 'ab' };

async function setupFakeVsock(agent: StubAgentHandler) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-agentfwd-'));
  const path = join(dir, 'vsock.sock');

  const fake = await startStubAgent(path, agent);

  return {
    path,
    [Symbol.dispose]() {
      fake.close();

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a listener answers with its socket, then names each client', async () => {
  using vsock = await setupFakeVsock((socket, request) => {
    expect(decodeJsonPayload(request)).toEqual({ op: 'agent.listen' });

    socket.write(encodeJsonFrame(FRAME_TYPES.response, LISTENING));
    socket.write(encodeJsonFrame(FRAME_TYPES.connection, { id: 1 }));
    socket.end(encodeJsonFrame(FRAME_TYPES.connection, { id: 2 }));
  });

  const listener = await openListener(vsock.path, { network: 'ssh-agent' });

  const ids: number[] = [];

  for await (const id of listener.connections()) {
    ids.push(id);
  }

  expect(listener).toMatchObject({ path: LISTENING.path, id: 'ab' });
  expect(ids).toEqual([1, 2]);
});

test('an agent from before agent forwarding gets AGENT_OUTDATED', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op agent.listen' },
      }),
    );
  });

  const failure = await readRejection(openListener(vsock.path, { network: 'ssh-agent' }));

  expect(failure).toMatchObject({ code: 'AGENT_OUTDATED' });
});

test('an accept names its listener and client, and a gone client is NO_CONNECTION', async () => {
  using vsock = await setupFakeVsock((socket, request) => {
    expect(decodeJsonPayload(request)).toEqual({
      op: 'agent.accept',
      listener: 'ab',
      connection: 7,
    });

    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'NO_CONNECTION', message: 'no waiting connection 7' },
      }),
    );
  });

  const failure = await readRejection(openAccept(vsock.path, 'ab', 7));

  expect(failure).toMatchObject({ code: 'NO_CONNECTION' });
});

test('a reverse forward listens on a port, a path, or a socket the agent makes', async () => {
  const requests: unknown[] = [];

  using vsock = await setupFakeVsock((socket, request) => {
    const asked = decodeJsonPayload(request);

    requests.push(asked);

    const answer =
      typeof asked === 'object' && asked !== null && Reflect.get(asked, 'network') === 'tcp'
        ? { ok: true, port: 41_000, listener: 'cd' }
        : { ok: true, path: '/run/imp/forward/cd/sock', listener: 'cd' };

    socket.end(encodeJsonFrame(FRAME_TYPES.response, answer));
  });

  const port = await openListener(vsock.path, { network: 'tcp', port: 0 });
  const own = await openListener(vsock.path, { network: 'unix', path: null });

  await openListener(vsock.path, { network: 'unix', path: '/tmp/atc.sock' });

  expect(port).toMatchObject({ port: 41_000, path: null, id: 'cd' });
  expect(own).toMatchObject({ port: null, path: '/run/imp/forward/cd/sock' });

  expect(requests).toEqual([
    { op: 'listen', network: 'tcp', address: '127.0.0.1:0' },
    { op: 'listen', network: 'unix', address: '' },
    { op: 'listen', network: 'unix', address: '/tmp/atc.sock' },
  ]);
});

test('an agent from before reverse forwards gets AGENT_OUTDATED for reverse forwards', async () => {
  using vsock = await setupFakeVsock((socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op listen' },
      }),
    );
  });

  const failure = await readRejection(openListener(vsock.path, { network: 'tcp', port: 0 }));

  expect(failure).toMatchObject({ code: 'AGENT_OUTDATED' });
  expect(String(failure)).toContain('no reverse forwards');
});
