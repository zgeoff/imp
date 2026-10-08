import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { openAgentConnection } from '../agent-client/agent-connection';
import { openExecStream } from '../agent-client/exec-stream';
import { FRAME_TYPES, decodeJsonPayload } from '../agent-client/frame-codec';
import { buildStubExecGuest } from './build-stub-exec-guest';
import { startStubExecAgent } from './start-stub-exec-agent';

// a temp dir for the agent's socket, and `stack`, whose releases (the
// agent's and the streams') run before the dir goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'stub-exec-agent-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { dir, stack };
}

test('it runs an exec on the guest and sends its output and exit as frames', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'echo hi'],
    tty: false,
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('hi\n') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it sends the guest’s stderr as frames', async () => {
  const ctx = await setupTest();
  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), buildStubExecGuest());

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'fail'],
    tty: false,
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('partial') },
    { type: 'stderr', data: new TextEncoder().encode('boom') },
    { type: 'exit', code: 3, signal: 0 },
  ]);
});

test('it sends a detach of the guest’s command as a frame', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const detached = { type: 'detached' as const, reason: 'the session went on' };

  // the guest's stream, ended by a detach where its command would run on
  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), {
    openExec: async (name, request) => {
      const stream = await guest.openExec(name, request);

      return {
        ...stream,
        events: async function* events() {
          yield await Promise.resolve(detached);
        },
      };
    },
  });

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: false,
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([{ type: 'detached', reason: 'the session went on' }]);
});

test('it hands the guest the request as impd sent it', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'echo hi'],
    env: ['A=1'],
    cwd: '/work',
    tty: false,
    killGraceMs: 50,
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  expect(guest.requests).toStrictEqual([
    { argv: ['/bin/sh', '-c', 'echo hi'], env: ['A=1'], cwd: '/work', tty: false, killGraceMs: 50 },
  ]);
});

test('it reports the guest’s group kill in STARTED', async () => {
  const ctx = await setupTest();
  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), buildStubExecGuest());

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: false,
    killGraceMs: 50,
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  expect(stream.groupKill).toBeTrue();
});

test('it hands the guest the user, session and terminal size impd sent', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const connection = await openAgentConnection(join(ctx.dir, 'v.sock'));

  ctx.stack.defer(() => {
    connection.close();
  });

  connection.sendJson(FRAME_TYPES.request, {
    op: 'exec',
    argv: ['/bin/sh', '-c', 'echo hi'],
    tty: true,
    cols: 120,
    rows: 40,
    user: 'dev',
    session: 'work',
  });

  await connection.next();

  expect(guest.requests).toStrictEqual([
    {
      argv: ['/bin/sh', '-c', 'echo hi'],
      tty: true,
      cols: 120,
      rows: 40,
      user: 'dev',
      session: 'work',
    },
  ]);
});

test('it echoes the asked kill grace in STARTED, capped at a minute', async () => {
  const ctx = await setupTest();
  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), buildStubExecGuest());

  ctx.stack.defer(() => {
    agent.close();
  });

  const connection = await openAgentConnection(join(ctx.dir, 'v.sock'));

  ctx.stack.defer(() => {
    connection.close();
  });

  connection.sendJson(FRAME_TYPES.request, {
    op: 'exec',
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: false,
    kill_grace_ms: 120_000,
  });

  const started = await connection.next();

  invariant(started);

  expect(decodeJsonPayload(started)).toStrictEqual({ pid: 42, kill_grace_ms: 60_000 });
});

test('it echoes the asked kill grace in STARTED as it was under a minute', async () => {
  const ctx = await setupTest();
  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), buildStubExecGuest());

  ctx.stack.defer(() => {
    agent.close();
  });

  const connection = await openAgentConnection(join(ctx.dir, 'v.sock'));

  ctx.stack.defer(() => {
    connection.close();
  });

  connection.sendJson(FRAME_TYPES.request, {
    op: 'exec',
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: false,
    kill_grace_ms: 50,
  });

  const started = await connection.next();

  invariant(started);

  expect(decodeJsonPayload(started)).toStrictEqual({ pid: 42, kill_grace_ms: 50 });
});

test('it leaves the kill grace out of STARTED for an exec with a terminal', async () => {
  const ctx = await setupTest();
  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), buildStubExecGuest());

  ctx.stack.defer(() => {
    agent.close();
  });

  const connection = await openAgentConnection(join(ctx.dir, 'v.sock'));

  ctx.stack.defer(() => {
    connection.close();
  });

  connection.sendJson(FRAME_TYPES.request, {
    op: 'exec',
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: true,
    kill_grace_ms: 50,
  });

  const started = await connection.next();

  invariant(started);

  expect(decodeJsonPayload(started)).toStrictEqual({ pid: 42 });
});

test('it leaves the kill grace out of STARTED for a guest from before the group kill', async () => {
  const ctx = await setupTest();

  const agent = await startStubExecAgent(
    join(ctx.dir, 'v.sock'),
    buildStubExecGuest({ oldAgent: true }),
  );

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: false,
    killGraceMs: 50,
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  expect(stream.groupKill).toBeFalse();
});

test('it names the guest’s session in STARTED', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  // the guest's stream, as a session's that this exec created
  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), {
    openExec: async (name, request) => {
      const stream = await guest.openExec(name, request);

      return { ...stream, session: 'work', created: true };
    },
  });

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: true,
    session: 'work',
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  expect(stream.session).toBe('work');
  expect(stream.created).toBeTrue();
});

test('it passes a signal to the guest’s command', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: false,
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  stream.sendSignal(15);

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([{ type: 'exit', code: 143, signal: 15 }]);
  expect(guest.signals).toStrictEqual(['sleepy:15']);
});

test('it passes stdin and its end to the guest’s command', async () => {
  const ctx = await setupTest();
  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), buildStubExecGuest());

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'cat'],
    tty: false,
  });

  ctx.stack.defer(() => {
    stream.close();
  });

  stream.writeStdin(new TextEncoder().encode('typed'));
  stream.closeStdin();

  const events = await Array.fromAsync(stream.events());

  expect(events).toStrictEqual([
    { type: 'stdout', data: new TextEncoder().encode('typed') },
    { type: 'exit', code: 0, signal: 0 },
  ]);
});

test('it closes the guest’s stream when impd drops the connection', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const stream = await openExecStream(join(ctx.dir, 'v.sock'), {
    argv: ['/bin/sh', '-c', 'sleepy'],
    tty: false,
  });

  stream.close();

  await waitFor(() => {
    invariant(guest.closed[0]);
  });

  expect(guest.closed).toStrictEqual(['sleepy']);
});

test('it refuses an op other than exec with UNKNOWN_OP', async () => {
  const ctx = await setupTest();
  const agent = await startStubExecAgent(join(ctx.dir, 'v.sock'), buildStubExecGuest());

  ctx.stack.defer(() => {
    agent.close();
  });

  const connection = await openAgentConnection(join(ctx.dir, 'v.sock'));

  ctx.stack.defer(() => {
    connection.close();
  });

  connection.sendJson(FRAME_TYPES.request, { op: 'session.tap', session: 'web' });

  const response = await connection.next();

  invariant(response);

  expect(response.type).toBe(FRAME_TYPES.response);

  expect(decodeJsonPayload(response)).toStrictEqual({
    error: { code: 'UNKNOWN_OP', message: 'unknown op session.tap' },
  });
});
