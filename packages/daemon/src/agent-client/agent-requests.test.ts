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

// a hostile agent can send anything; each name must fail before impd touches the disk
test.each([
  ['generation is a slash', { execution_generation: '/' }],
  ['generation is a backslash', { execution_generation: '\\' }],
  ['generation is a path with a slash', { execution_generation: 'a/b' }],
  ['generation is a path with a backslash', { execution_generation: String.raw`a\b` }],
  ['generation is the parent directory', { execution_generation: '..' }],
  ['generation is the current directory', { execution_generation: '.' }],
  ['generation is a relative traversal', { execution_generation: '../../../evil' }],
  ['generation is a backslash traversal', { execution_generation: String.raw`..\..\evil` }],
  ['generation is an absolute path', { execution_generation: '/etc/passwd' }],
  ['generation is a drive path', { execution_generation: String.raw`C:\evil` }],
  ['generation is a NUL', { execution_generation: '\0' }],
  ['generation is a NUL inside a name', { execution_generation: 'a\0b' }],
  ['generation is a value of 4096 characters', { execution_generation: 'x'.repeat(4096) }],
  ['generation is an empty value', { execution_generation: '' }],
  ['generation is 31 hex characters and a slash', { execution_generation: `${'a'.repeat(31)}/` }],
  [
    'generation is 31 hex characters and a backslash',
    { execution_generation: `${'a'.repeat(31)}\\` },
  ],
  [
    'generation is a traversal between hex characters',
    { execution_generation: `${'a'.repeat(16)}/../${'a'.repeat(13)}` },
  ],
  ['generation is a slash and 31 hex characters', { execution_generation: `/${'a'.repeat(31)}` }],
  ['generation is 31 hex characters and a NUL', { execution_generation: `${'a'.repeat(31)}\0` }],
  ['generation is 31 hex characters', { execution_generation: 'a'.repeat(31) }],
  ['generation is 33 hex characters', { execution_generation: 'a'.repeat(33) }],
  ['generation is 32 uppercase hex characters', { execution_generation: 'A'.repeat(32) }],
  ['generation is 32 letters that are not hex', { execution_generation: 'g'.repeat(32) }],
  ['generation is a UUID', { execution_generation: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11' }],
  ['boot id is a slash', { boot_id: '/' }],
  ['boot id is a backslash', { boot_id: '\\' }],
  ['boot id is a path with a slash', { boot_id: 'a/b' }],
  ['boot id is a path with a backslash', { boot_id: String.raw`a\b` }],
  ['boot id is the parent directory', { boot_id: '..' }],
  ['boot id is the current directory', { boot_id: '.' }],
  ['boot id is a relative traversal', { boot_id: '../../../evil' }],
  ['boot id is a backslash traversal', { boot_id: String.raw`..\..\evil` }],
  ['boot id is an absolute path', { boot_id: '/etc/passwd' }],
  ['boot id is a drive path', { boot_id: String.raw`C:\evil` }],
  ['boot id is a NUL', { boot_id: '\0' }],
  ['boot id is a NUL inside a name', { boot_id: 'a\0b' }],
  ['boot id is a value of 4096 characters', { boot_id: 'x'.repeat(4096) }],
  ['boot id is a UUID that ends in a slash', { boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1/' }],
  [
    'boot id is a UUID that ends in a backslash',
    { boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1\\' },
  ],
  ['boot id is a traversal into a UUID', { boot_id: '../c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11' }],
  ['boot id is a UUID and a NUL', { boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11\0' }],
  ['boot id is a UUID one character short', { boot_id: 'f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11' }],
  ['boot id is a UUID one character long', { boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d110' }],
  ['boot id is an uppercase UUID', { boot_id: '4F3C0F86-8F8B-4C45-A3B4-8E1C1E9B0D11' }],
  [
    'boot id is a UUID with a letter that is not hex',
    { boot_id: '4g3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11' },
  ],
  ['boot id is a UUID without its dashes', { boot_id: '4f3c0f868f8b4c45a3b48e1c1e9b0d11' }],
  ['session name is a slash', { name: '/' }],
  ['session name is a backslash', { name: '\\' }],
  ['session name is a path with a slash', { name: 'a/b' }],
  ['session name is a path with a backslash', { name: String.raw`a\b` }],
  ['session name is the parent directory', { name: '..' }],
  ['session name is the current directory', { name: '.' }],
  ['session name is a relative traversal', { name: '../../../evil' }],
  ['session name is a backslash traversal', { name: String.raw`..\..\evil` }],
  ['session name is an absolute path', { name: '/etc/passwd' }],
  ['session name is a drive path', { name: String.raw`C:\evil` }],
  ['session name is a NUL', { name: '\0' }],
  ['session name is a NUL inside a name', { name: 'a\0b' }],
  ['session name is a value of 4096 characters', { name: 'x'.repeat(4096) }],
  ['session name is an empty name', { name: '' }],
  ['session name is a name and a traversal', { name: 'main/..' }],
  ['session name is a name with a backslash', { name: String.raw`main\x` }],
  ['session name is a name and a NUL', { name: 'main\0' }],
  ['session name is a name of 33 characters', { name: 'a'.repeat(33) }],
  ['session name is an uppercase name', { name: 'Main' }],
  ['session name is a name that starts with a dash', { name: '-main' }],
  ['session name is a name with a dot', { name: 'main.log' }],
])('#sendActivity drops a session whose %s and keeps the rest', async (_label, forged) => {
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
