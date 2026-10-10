import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { startStubAgent } from '../test-utils/start-stub-agent';
import { startStubEchoExecAgent } from '../test-utils/start-stub-echo-exec-agent';
import { openAttachStream, openExecStream, openTapStream } from './exec-stream';
import { FRAME_TYPES, decodeJsonPayload, encodeFrame, encodeJsonFrame } from './frame-codec';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vsock-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { vsockPath: join(dir, 'vsock.sock') };
}

test('#openExecStream asks the agent for an exec', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 42 }));
  });

  const stream = await openExecStream(ctx.vsockPath, { argv: ['cat'], tty: false });

  stream.close();

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({ op: 'exec', argv: ['cat'], tty: false });
});

test('#openExecStream streams stdin in, then output and the exit out', async () => {
  const ctx = setupTest();

  await startStubEchoExecAgent(ctx.vsockPath, {
    pid: 42,
    stderr: new TextEncoder().encode('bye'),
    exit: { code: 3, signal: 0 },
  });

  const stream = await openExecStream(ctx.vsockPath, { argv: ['cat'], tty: false });

  stream.writeStdin(new TextEncoder().encode('hi'));
  stream.closeStdin();

  const events = await Array.fromAsync(stream.events());

  expect(stream.pid).toBe(42);

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('hi') },
    { type: 'stderr', data: new TextEncoder().encode('bye') },
    { type: 'exit', code: 3, signal: 0 },
  ]);
});

test('#openExecStream rejects with the agent error when the process cannot start', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'EXEC_FAILED', message: 'start nope: no such file' },
      }),
    );
  });

  expect(openExecStream(ctx.vsockPath, { argv: ['nope'], tty: false })).rejects.toMatchObject({
    code: 'EXEC_FAILED',
    detail: 'start nope: no such file',
  });
});

test('#openExecStream rejects and closes its connection when STARTED never comes', async () => {
  const ctx = setupTest();
  const closed = Promise.withResolvers<void>();

  // an agent that never answers, so the start deadline alone decides
  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.on('close', () => {
      closed.resolve();
    });
  });

  expect(
    openExecStream(ctx.vsockPath, { argv: ['sleep'], tty: false }, 1),
  ).rejects.toThrowWithMessage(Error, 'agent did not answer within 1 ms');

  await expect(closed.promise).toResolve();
});

test('#openExecStream rejects when the agent closes the connection before the process starts', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end();
  });

  expect(openExecStream(ctx.vsockPath, { argv: ['true'], tty: false })).rejects.toThrowWithMessage(
    Error,
    'agent closed the exec connection before the process started',
  );
});

test('#openExecStream rejects when the first frame from the agent is not STARTED', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('early')));
  });

  expect(openExecStream(ctx.vsockPath, { argv: ['true'], tty: false })).rejects.toThrowWithMessage(
    Error,
    'agent exec: expected STARTED, got frame type 8',
  );
});

test('#openExecStream rejects with AGENT_OUTDATED and closes the connection when an agent from before sessions starts a session exec plain', async () => {
  const ctx = setupTest();
  const closed = Promise.withResolvers<void>();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.on('close', () => {
      closed.resolve();
    });

    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 42 }));
  });

  expect(
    openExecStream(ctx.vsockPath, { argv: ['sh'], tty: true, session: 'main' }),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });

  await expect(closed.promise).toResolve();
});

test('#openExecStream opens a plain exec with no session', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 42 }));
  });

  const stream = await openExecStream(ctx.vsockPath, { argv: ['true'], tty: false });

  stream.close();

  expect(stream.session).toBeNull();
  expect(stream.created).toBe(false);
  expect(stream.output).toBeNull();
});

test('#openExecStream sends the kill grace to the agent', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 42, kill_grace_ms: 2000 }));
  });

  const stream = await openExecStream(ctx.vsockPath, {
    argv: ['sleep', '9'],
    tty: false,
    killGraceMs: 2000,
  });

  stream.close();

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'exec',
    argv: ['sleep', '9'],
    tty: false,
    kill_grace_ms: 2000,
  });
});

test("#openExecStream arms the group kill when the agent's STARTED echoes the kill grace", async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 42, kill_grace_ms: 2000 }));
  });

  const stream = await openExecStream(ctx.vsockPath, {
    argv: ['sleep', '9'],
    tty: false,
    killGraceMs: 2000,
  });

  stream.close();

  expect(stream.groupKill).toBe(true);
});

// an agent from before 0.8.0 ignores the field and does not echo it, so the
// host keeps cleaning up the group itself
test('#openExecStream leaves the group kill off for an agent that does not echo the kill grace', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 42 }));
  });

  const stream = await openExecStream(ctx.vsockPath, {
    argv: ['sleep', '9'],
    tty: false,
    killGraceMs: 2000,
  });

  stream.close();

  expect(stream.groupKill).toBe(false);
});

test('#openExecStream leaves the group kill off without a kill grace', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 42 }));
  });

  const stream = await openExecStream(ctx.vsockPath, { argv: ['true'], tty: false });

  stream.close();

  expect(stream.groupKill).toBe(false);
});

test('#openExecStream sends an outer exec as the exec.outer op', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 42 }));
  });

  const stream = await openExecStream(ctx.vsockPath, {
    argv: ['ls', '/user'],
    tty: false,
    outer: true,
  });

  stream.close();

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'exec.outer',
    argv: ['ls', '/user'],
    tty: false,
  });
});

test('#openExecStream rejects an outer exec with AGENT_OUTDATED for an agent from before it', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op exec.outer' },
      }),
    );
  });

  expect(
    openExecStream(ctx.vsockPath, { argv: ['ls', '/user'], tty: false, outer: true }),
  ).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
    detail: "the imp's agent has no exec --agent yet; stop and start the imp to update it",
  });
});

test('#openAttachStream asks the agent to attach to the session', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 42, session: 'main' }));
  });

  const stream = await openAttachStream(ctx.vsockPath, { session: 'main', cols: 80, rows: 24 });

  stream.close();

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'session.attach',
    session: 'main',
    cols: 80,
    rows: 24,
  });
});

test('#openAttachStream streams the replay, then detached', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 42, session: 'main' }));
    socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('replay')));
    socket.end(encodeJsonFrame(FRAME_TYPES.detached, { reason: 'taken_over' }));
  });

  const stream = await openAttachStream(ctx.vsockPath, { session: 'main' });
  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('replay') },
    { type: 'detached', reason: 'taken_over' },
  ]);
});

test('#openAttachStream replays as before for an agent from before output offsets', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 42, session: 'main' }));
  });

  const stream = await openAttachStream(ctx.vsockPath, { session: 'main' });

  stream.close();

  expect(stream.pid).toBe(42);
  expect(stream.session).toBe('main');
  expect(stream.created).toBe(false);
  expect(stream.output).toStrictEqual({ continuity: 'none' });
});

test('#openAttachStream sends a resume in the agent shape, without wake', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 42, session: 'main' }));
  });

  const stream = await openAttachStream(ctx.vsockPath, {
    session: 'main',
    resumeFrom: { executionGeneration: 'e'.repeat(32), offset: 4 },
    wake: false,
  });

  stream.close();

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'session.attach',
    session: 'main',
    resume_from: { execution_generation: 'e'.repeat(32), offset: 4 },
  });
});

test("#openAttachStream places the session's output from STARTED", async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.started, {
        pid: 42,
        session: 'main',
        output: {
          boot_id: '11111111-1111-4111-8111-111111111111',
          execution_generation: 'e'.repeat(32),
          buffer_start: 10,
          end: 20,
          offset: 10,
          prelude: 0,
          previous: {
            execution_generation: 'd'.repeat(32),
            end: 7,
            exit: { code: 0, signal: 9 },
          },
          resume: { kind: 'gap', from: 4, to: 10 },
        },
      }),
    );
  });

  const stream = await openAttachStream(ctx.vsockPath, {
    session: 'main',
    resumeFrom: { executionGeneration: 'e'.repeat(32), offset: 4 },
  });

  stream.close();

  expect(stream.output).toStrictEqual({
    continuity: 'offsets',
    bootId: '11111111-1111-4111-8111-111111111111',
    executionGeneration: 'e'.repeat(32),
    bufferStart: 10,
    end: 20,
    offset: 10,
    prelude: 0,
    coldBoots: [],
    previous: { executionGeneration: 'd'.repeat(32), end: 7, exitCode: null },
    resume: { kind: 'gap', from: 4, to: 10 },
  });
});

test("#openAttachStream rejects with NO_SESSION carrying the agent's data in the API shape", async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: {
          code: 'NO_SESSION',
          message: 'no session "main"',
          data: {
            boot_id: '11111111-1111-4111-8111-111111111111',
            previous: {
              execution_generation: 'd'.repeat(32),
              end: 7,
              exit: { code: 3, signal: 0 },
            },
          },
        },
      }),
    );
  });

  expect(openAttachStream(ctx.vsockPath, { session: 'main' })).rejects.toMatchObject({
    code: 'NO_SESSION',
    data: {
      bootId: '11111111-1111-4111-8111-111111111111',
      coldBoots: [],
      previous: { executionGeneration: 'd'.repeat(32), end: 7, exitCode: 3 },
    },
  });
});

test("#openAttachStream rejects with INVALID_RESUME carrying the agent's data in the API shape", async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: {
          code: 'INVALID_RESUME',
          message: 'offset past the end',
          data: { end: 20, buffer_start: 10 },
        },
      }),
    );
  });

  expect(
    openAttachStream(ctx.vsockPath, {
      session: 'main',
      resumeFrom: { executionGeneration: 'e'.repeat(32), offset: 99 },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_RESUME', data: { end: 20, bufferStart: 10 } });
});

test('#openAttachStream drops error data that does not parse', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'NO_SESSION', message: 'no session "main"', data: { boot_id: 'a/b' } },
      }),
    );
  });

  expect(openAttachStream(ctx.vsockPath, { session: 'main' })).rejects.toMatchObject({
    code: 'NO_SESSION',
    data: undefined,
  });
});

test('#openAttachStream rejects with AGENT_OUTDATED for an agent from before sessions', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op' },
      }),
    );
  });

  expect(openAttachStream(ctx.vsockPath, { session: 'main' })).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
    detail: "the imp's agent has no sessions yet; stop and start the imp to update it",
  });
});

test('#openTapStream asks the agent to tap the session from the resume point', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 42, session: 'main' }));
  });

  const stream = await openTapStream(ctx.vsockPath, 'main', {
    executionGeneration: 'e'.repeat(32),
    offset: 9,
  });

  stream.close();

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'session.tap',
    session: 'main',
    resume_from: { execution_generation: 'e'.repeat(32), offset: 9 },
  });
});

test('#openTapStream reports the log as on when a logged STARTED says so', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.started, {
        pid: 42,
        session: 'main',
        output: {
          boot_id: '11111111-1111-4111-8111-111111111111',
          execution_generation: 'e'.repeat(32),
          buffer_start: 0,
          end: 9,
          offset: 9,
          prelude: 0,
          resume: { kind: 'exact' },
          log: true,
        },
      }),
    );
  });

  const stream = await openTapStream(ctx.vsockPath, 'main');

  stream.close();

  expect(stream.output).toStrictEqual({
    continuity: 'offsets',
    bootId: '11111111-1111-4111-8111-111111111111',
    executionGeneration: 'e'.repeat(32),
    bufferStart: 0,
    end: 9,
    offset: 9,
    prelude: 0,
    coldBoots: [],
    resume: { kind: 'exact' },
    log: { enabled: true },
  });
});

test('#openTapStream rejects with AGENT_OUTDATED for an agent from before session logs', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op' },
      }),
    );
  });

  expect(openTapStream(ctx.vsockPath, 'main')).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
    detail: "the imp's agent has no session logs yet; stop and start the imp to update it",
  });
});

// a hostile agent can send anything; each name must fail before impd touches the disk
test.each([
  ['a slash', '/'],
  ['a backslash', '\\'],
  ['a path with a slash', 'a/b'],
  ['a path with a backslash', String.raw`a\b`],
  ['the parent directory', '..'],
  ['the current directory', '.'],
  ['a relative traversal', '../../../evil'],
  ['a backslash traversal', String.raw`..\..\evil`],
  ['an absolute path', '/etc/passwd'],
  ['a drive path', String.raw`C:\evil`],
  ['a NUL', '\0'],
  ['a NUL inside a name', 'a\0b'],
  ['a value of 4096 characters', 'x'.repeat(4096)],
  ['an empty value', ''],
  ['31 hex characters and a slash', `${'a'.repeat(31)}/`],
  ['31 hex characters and a backslash', `${'a'.repeat(31)}\\`],
  ['a traversal between hex characters', `${'a'.repeat(16)}/../${'a'.repeat(13)}`],
  ['a slash and 31 hex characters', `/${'a'.repeat(31)}`],
  ['31 hex characters and a NUL', `${'a'.repeat(31)}\0`],
  ['31 hex characters', 'a'.repeat(31)],
  ['33 hex characters', 'a'.repeat(33)],
  ['32 uppercase hex characters', 'A'.repeat(32)],
  ['32 letters that are not hex', 'g'.repeat(32)],
  ['a UUID', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
])('#openTapStream rejects a STARTED whose generation is %s', async (_label, value) => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.started, {
        pid: 42,
        session: 'main',
        output: {
          boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
          execution_generation: value,
          buffer_start: 0,
          end: 0,
          offset: 0,
          prelude: 0,
          log: true,
        },
      }),
    );
  });

  expect(openTapStream(ctx.vsockPath, 'main')).rejects.toMatchObject({
    name: 'ZodError',
    issues: expect.toPartiallyContain({
      path: ['output', 'execution_generation'],
      code: 'invalid_format',
    }),
  });
});

test.each([
  ['a slash', '/'],
  ['a backslash', '\\'],
  ['a path with a slash', 'a/b'],
  ['a path with a backslash', String.raw`a\b`],
  ['the parent directory', '..'],
  ['the current directory', '.'],
  ['a relative traversal', '../../../evil'],
  ['a backslash traversal', String.raw`..\..\evil`],
  ['an absolute path', '/etc/passwd'],
  ['a drive path', String.raw`C:\evil`],
  ['a NUL', '\0'],
  ['a NUL inside a name', 'a\0b'],
  ['a value of 4096 characters', 'x'.repeat(4096)],
  ['a UUID that ends in a slash', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1/'],
  ['a UUID that ends in a backslash', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1\\'],
  ['a traversal into a UUID', '../c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a UUID and a NUL', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11\0'],
  ['a UUID one character short', 'f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a UUID one character long', '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d110'],
  ['an uppercase UUID', '4F3C0F86-8F8B-4C45-A3B4-8E1C1E9B0D11'],
  ['a UUID with a letter that is not hex', '4g3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11'],
  ['a UUID without its dashes', '4f3c0f868f8b4c45a3b48e1c1e9b0d11'],
])('#openTapStream rejects a STARTED whose boot id is %s', async (_label, value) => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.started, {
        pid: 42,
        session: 'main',
        output: {
          boot_id: value,
          execution_generation: '0123456789abcdef0123456789abcdef',
          buffer_start: 0,
          end: 0,
          offset: 0,
          prelude: 0,
          log: true,
        },
      }),
    );
  });

  expect(openTapStream(ctx.vsockPath, 'main')).rejects.toMatchObject({
    name: 'ZodError',
    issues: expect.toPartiallyContain({ path: ['output', 'boot_id'], code: 'invalid_format' }),
  });
});

test.each([
  ['a slash', '/'],
  ['a backslash', '\\'],
  ['a path with a slash', 'a/b'],
  ['a path with a backslash', String.raw`a\b`],
  ['the parent directory', '..'],
  ['the current directory', '.'],
  ['a relative traversal', '../../../evil'],
  ['a backslash traversal', String.raw`..\..\evil`],
  ['an absolute path', '/etc/passwd'],
  ['a drive path', String.raw`C:\evil`],
  ['a NUL', '\0'],
  ['a NUL inside a name', 'a\0b'],
  ['a value of 4096 characters', 'x'.repeat(4096)],
  ['an empty name', ''],
  ['a name and a traversal', 'main/..'],
  ['a name with a backslash', String.raw`main\x`],
  ['a name and a NUL', 'main\0'],
  ['a name of 33 characters', 'a'.repeat(33)],
  ['an uppercase name', 'Main'],
  ['a name that starts with a dash', '-main'],
  ['a name with a dot', 'main.log'],
])('#openTapStream rejects a STARTED whose session name is %s', async (_label, value) => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.started, {
        pid: 42,
        session: value,
        output: {
          boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
          execution_generation: '0123456789abcdef0123456789abcdef',
          buffer_start: 0,
          end: 0,
          offset: 0,
          prelude: 0,
          log: true,
        },
      }),
    );
  });

  expect(openTapStream(ctx.vsockPath, 'main')).rejects.toMatchObject({
    name: 'ZodError',
    issues: expect.toPartiallyContain({ path: ['session'], code: 'invalid_format' }),
  });
});
