import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRejection } from '../read-rejection';
import { openAgentAccept, openAgentListener } from './agent-forward-stream';
import { startFakeAgent } from './fake-agent';
import type { FakeAgentHandler } from './fake-agent';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from './frame-codec';

const LISTENING = { ok: true, path: '/run/imp/ssh-agent/ab/agent.sock', listener: 'ab' };

async function setupFakeVsock(agent: FakeAgentHandler) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-agentfwd-'));
  const path = join(dir, 'vsock.sock');

  const fake = await startFakeAgent(path, agent);

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

  const listener = await openAgentListener(vsock.path);

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

  const failure = await readRejection(openAgentListener(vsock.path));

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

  const failure = await readRejection(openAgentAccept(vsock.path, 'ab', 7));

  expect(failure).toMatchObject({ code: 'NO_CONNECTION' });
});
