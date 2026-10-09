import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { startStubAgent } from '../test-utils/start-stub-agent';
import { sendActivity, sendAgentRequest, sendPing, sendSessionKill } from './agent-requests';
import { FRAME_TYPES, decodeJsonPayload, encodeFrame, encodeJsonFrame } from './frame-codec';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vsock-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { vsockPath: join(dir, 'vsock.sock') };
}

test('#sendPing sends a ping through the CONNECT handshake', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.response, { ok: true, version: '0.1.0', uptime_ms: 5 }));
  });

  await sendPing(ctx.vsockPath);

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({ op: 'ping' });
});

test("#sendPing resolves with the agent's answer", async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.response, { ok: true, version: '0.1.0', uptime_ms: 5 }));
  });

  const ping = await sendPing(ctx.vsockPath);

  expect(ping).toStrictEqual({ ok: true, version: '0.1.0', uptime_ms: 5 });
});

test('#sendAgentRequest rejects when the agent closes the connection without a response', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end();
  });

  expect(sendAgentRequest(ctx.vsockPath, { op: 'ping' })).rejects.toThrowWithMessage(
    Error,
    'agent ping: no response',
  );
});

test('#sendAgentRequest rejects when the agent answers with a frame that is not a response', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('early')));
  });

  expect(sendAgentRequest(ctx.vsockPath, { op: 'ping' })).rejects.toThrowWithMessage(
    Error,
    'agent ping: no response',
  );
});

test('#sendAgentRequest rejects when the agent does not answer within the timeout', async () => {
  const ctx = setupTest();

  // an agent that never answers, so the deadline alone decides
  await startStubAgent(ctx.vsockPath, () => {});

  expect(sendAgentRequest(ctx.vsockPath, { op: 'ping' }, 1)).rejects.toThrowWithMessage(
    Error,
    'agent did not answer within 1 ms',
  );
});

test('#sendAgentRequest rejects with the error the agent answers', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'BAD_REQUEST', message: 'missing op', data: { field: 'op' } },
      }),
    );
  });

  expect(sendAgentRequest(ctx.vsockPath, { op: 'ping' })).rejects.toMatchObject({
    name: 'AgentError',
    code: 'BAD_REQUEST',
    detail: 'missing op',
    data: { field: 'op' },
  });
});

test('#sendActivity lists no sessions for an agent from before sessions', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, { tcp_established: 0, exec_sessions: 0, load1: 0 }),
    );
  });

  const activity = await sendActivity(ctx.vsockPath);

  expect(activity.sessions).toStrictEqual([]);
});

// each field is held to the form the real agent makes; the agent-ids tests cover every form
test.each([
  ['a generation with a traversal', { execution_generation: '../../../evil' }],
  ['a boot id with a NUL', { boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11\0' }],
  ['a session name with a slash', { name: 'a/b' }],
])('#sendActivity drops a session with %s and keeps the rest', async (_label, forged) => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    const good = {
      name: 'main',
      pid: 1,
      argv: ['sh'],
      state: 'running',
      attached: false,
      cols: 80,
      rows: 24,
      started_unix_ms: 1,
      execution_generation: '0123456789abcdef0123456789abcdef',
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    };

    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        tcp_established: 0,
        exec_sessions: 0,
        load1: 0,
        sessions: [good, { ...good, ...forged }],
      }),
    );
  });

  const activity = await sendActivity(ctx.vsockPath);

  expect(activity.sessions).toStrictEqual([
    {
      name: 'main',
      pid: 1,
      argv: ['sh'],
      state: 'running',
      attached: false,
      cols: 80,
      rows: 24,
      started_unix_ms: 1,
      execution_generation: '0123456789abcdef0123456789abcdef',
      boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    },
  ]);
});

test('#sendSessionKill rejects with NO_SESSION for a session that does not exist', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'NO_SESSION', message: 'no session "main"' },
      }),
    );
  });

  expect(sendSessionKill(ctx.vsockPath, 'main')).rejects.toMatchObject({ code: 'NO_SESSION' });
});

test('#sendSessionKill rejects with AGENT_OUTDATED for an agent from before sessions', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op' },
      }),
    );
  });

  expect(sendSessionKill(ctx.vsockPath, 'main')).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
  });
});
