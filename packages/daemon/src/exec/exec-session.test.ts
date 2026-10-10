import { expect, test } from 'bun:test';
import {
  EXEC_CHANNELS,
  EXEC_MAX_STDIN_FRAME_BYTES,
  EXEC_STDIN_WINDOW_BYTES,
  EXEC_STDOUT_WINDOW_BYTES,
  encodeExecFrame,
} from '@imp/api';
import { waitFor } from '@imp/test-utils/wait-for';
import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import { buildMockSessionOutput } from '../test-utils/build-mock-session-output';
import { buildStubAgentExecStream } from '../test-utils/build-stub-agent-exec-stream';
import { buildStubExecBackend } from '../test-utils/build-stub-exec-backend';
import { buildStubExecSocket } from '../test-utils/build-stub-exec-socket';
import { createExecSession } from './exec-session';

test("it opens the exec with the start's argv, env and size", async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, stub.backend);

  session.handleMessage({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: true,
    env: { TERM: 'xterm' },
    cols: 100,
    rows: 30,
  });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([{ type: 'started', pid: 7 }]);
  });

  expect(stub.opens).toStrictEqual([
    {
      kind: 'exec',
      name: 'dev',
      request: { argv: ['sh'], tty: true, env: ['TERM=xterm'], cols: 100, rows: 30 },
      feature: undefined,
    },
  ]);
});

test('it passes input sent before started to the stream in order', async () => {
  const fake = buildStubAgentExecStream();
  const stub = buildStubExecBackend({ exec: fake.stream });
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, stub.backend);

  session.handleMessage({ type: 'start', name: 'dev', argv: ['sh'], tty: true });
  session.handleMessage(encodeExecFrame(EXEC_CHANNELS.stdin, new TextEncoder().encode('ls\n')));
  session.handleMessage({ type: 'resize', cols: 120, rows: 40 });
  session.handleMessage({ type: 'signal', signal: 'SIGINT' });
  session.handleMessage({ type: 'stdin_eof' });

  await waitFor(() => {
    expect(fake.input).toStrictEqual(['stdin:ls\n', 'resize:120x40', 'signal:2', 'eof']);
  });
});

test('it sends the output and the exit to the client, then closes the socket', async () => {
  const fake = buildStubAgentExecStream();
  const stub = buildStubExecBackend({ exec: fake.stream });
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, stub.backend);

  session.handleMessage({ type: 'start', name: 'dev', argv: ['sh'], tty: true });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('out') });
  fake.emitEvent({ type: 'exit', code: 137, signal: 9 });

  await waitFor(() => {
    expect(socket.closes).toStrictEqual([1000]);
  });

  expect(socket.sent).toStrictEqual([
    { type: 'started', pid: 7 },
    [EXEC_CHANNELS.stdout, 'out'],
    { type: 'exit', code: null, signal: 'SIGKILL' },
  ]);
});

test('it closes the stream and records activity once the exec exits', async () => {
  const fake = buildStubAgentExecStream();
  const stub = buildStubExecBackend({ exec: fake.stream });
  const session = createExecSession(buildStubExecSocket().peer, stub.backend);

  session.handleMessage({ type: 'start', name: 'dev', argv: ['true'], tty: false });
  fake.emitEvent({ type: 'exit', code: 0, signal: 0 });

  await waitFor(() => {
    expect(stub.activity).toStrictEqual(['dev']);
  });

  expect(fake.input).toStrictEqual(['close']);
});

test('it sends an exit code when no signal ended the process', async () => {
  const fake = buildStubAgentExecStream();
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  session.handleMessage({ type: 'start', name: 'dev', argv: ['false'], tty: false });
  fake.emitEvent({ type: 'exit', code: 1, signal: 0 });

  await waitFor(() => {
    expect(socket.closes).toStrictEqual([1000]);
  });

  expect(socket.sent.at(-1)).toStrictEqual({ type: 'exit', code: 1, signal: null });
});

test('it reports an exec that cannot start and closes the socket with 1011', async () => {
  const stub = buildStubExecBackend({ exec: new AgentError('EXEC_FAILED', 'no such file') });
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, stub.backend);

  session.handleMessage({ type: 'start', name: 'dev', argv: ['nope'], tty: false });

  await waitFor(() => {
    expect(socket.closes).toStrictEqual([1011]);
  });

  expect(socket.sent).toStrictEqual([
    { type: 'error', code: 'EXEC_FAILED', message: 'no such file' },
  ]);
});

test('it reports a plain failure to start by its message alone', async () => {
  const stub = buildStubExecBackend({ exec: new Error('dev is stopped') });
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, stub.backend);

  session.handleMessage({ type: 'start', name: 'dev', argv: ['sh'], tty: false });

  await waitFor(() => {
    expect(socket.closes).toStrictEqual([1011]);
  });

  expect(socket.sent).toStrictEqual([{ type: 'error', message: 'dev is stopped' }]);
});

test('it passes a contract error on with its data', async () => {
  const data = { budgetMib: 1024, usedMib: 900, requestedMib: 512 };

  const stub = buildStubExecBackend({
    exec: new ORPCError('RAM_BUDGET_EXCEEDED', { message: 'no room', data }),
  });

  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, stub.backend);

  session.handleMessage({ type: 'start', name: 'dev', argv: ['sh'], tty: false });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([
      { type: 'error', code: 'RAM_BUDGET_EXCEEDED', message: 'no room', data },
    ]);
  });
});

test('it rejects a control message before start', () => {
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, buildStubExecBackend().backend);

  session.handleMessage({ type: 'resize', cols: 1, rows: 1 });

  expect(socket.sent).toStrictEqual([{ type: 'error', message: 'resize before start' }]);
  expect(socket.closes).toStrictEqual([1011]);
});

test('it rejects a second start on the same socket', () => {
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, buildStubExecBackend().backend);

  session.handleMessage({ type: 'start', name: 'dev', argv: ['sh'], tty: false });
  session.handleMessage({ type: 'start', name: 'dev', argv: ['sh'], tty: false });

  expect(socket.sent).toStrictEqual([{ type: 'error', message: 'exec already started' }]);
  expect(socket.closes).toStrictEqual([1011]);
});

test('it reports a message that is not part of the protocol', () => {
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, buildStubExecBackend().backend);

  session.handleMessage({ type: 'launch', name: 'dev' });

  expect(socket.sent).toStrictEqual([
    { type: 'error', message: expect.toStartWith('bad exec message: ') },
  ]);

  expect(socket.closes).toStrictEqual([1011]);
});

test('it fails a plain exec whose stream ends without an exit', async () => {
  const fake = buildStubAgentExecStream();
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  session.handleMessage({ type: 'start', name: 'dev', argv: ['cat'], tty: false });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('partial') });
  fake.drop();

  await waitFor(() => {
    expect(socket.closes).toStrictEqual([1011]);
  });

  expect(socket.sent.at(-1)).toStrictEqual({
    type: 'error',
    message: 'the agent connection closed before the process exited',
  });
});

test('it reports a malformed binary frame instead of throwing', async () => {
  const fake = buildStubAgentExecStream();
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  session.handleMessage({ type: 'start', name: 'dev', argv: ['cat'], tty: false });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([{ type: 'started', pid: 7 }]);
  });

  session.handleMessage(new Uint8Array([]));

  expect(socket.sent.at(-1)).toStrictEqual({
    type: 'error',
    message: 'exec frame has an unknown channel byte: undefined',
  });

  expect(socket.closes).toStrictEqual([1011]);
});

test('it closes the stream when the client closes the socket', async () => {
  const fake = buildStubAgentExecStream();
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  session.handleMessage({ type: 'start', name: 'dev', argv: ['cat'], tty: false });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([{ type: 'started', pid: 7 }]);
  });

  session.handleClose();

  expect(fake.input).toStrictEqual(['close']);
});

test('it closes a stream that opens after the client closed the socket', async () => {
  const fake = buildStubAgentExecStream();
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  session.handleMessage({ type: 'start', name: 'dev', argv: ['cat'], tty: false });
  session.handleClose();

  await waitFor(() => {
    expect(fake.input).toStrictEqual(['close']);
  });

  expect(socket.sent).toStrictEqual([]);
});

test('it attaches to a session and ends with detached when the session is taken over', async () => {
  const fake = buildStubAgentExecStream({ session: 'main', created: false });
  const stub = buildStubExecBackend({ attach: fake.stream });
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, stub.backend);

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main', cols: 100, rows: 30 });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('replay') });
  fake.emitEvent({ type: 'detached', reason: 'taken_over' });

  await waitFor(() => {
    expect(socket.closes).toStrictEqual([1000]);
  });

  expect(stub.opens).toStrictEqual([
    { kind: 'attach', name: 'dev', request: { session: 'main', cols: 100, rows: 30 } },
  ]);

  expect(socket.sent).toStrictEqual([
    { type: 'started', pid: 7, session: 'main', created: false, output: { continuity: 'none' } },
    [EXEC_CHANNELS.stdout, 'replay'],
    { type: 'detached', reason: 'taken_over' },
  ]);
});

test('it starts a named session', async () => {
  const fake = buildStubAgentExecStream({ session: 'main', created: true });
  const stub = buildStubExecBackend({ exec: fake.stream });
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, stub.backend);

  session.handleMessage({ type: 'start', name: 'dev', argv: ['sh'], tty: true, session: 'main' });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([
      { type: 'started', pid: 7, session: 'main', created: true, output: { continuity: 'none' } },
    ]);
  });

  expect(stub.opens).toStrictEqual([
    {
      kind: 'exec',
      name: 'dev',
      request: { argv: ['sh'], tty: true, session: 'main' },
      feature: undefined,
    },
  ]);
});

test.each([true, false])(
  'it sends a kill grace to the agent and says in started whether the agent kills the group (%p)',
  async (groupKill) => {
    const fake = buildStubAgentExecStream({ groupKill });
    const stub = buildStubExecBackend({ exec: fake.stream });
    const socket = buildStubExecSocket();
    const session = createExecSession(socket.peer, stub.backend);

    session.handleMessage({
      type: 'start',
      name: 'dev',
      argv: ['sleep', '9'],
      tty: false,
      killGraceMs: 2000,
    });

    await waitFor(() => {
      expect(socket.sent).toStrictEqual([{ type: 'started', pid: 7, groupKill }]);
    });

    expect(stub.opens).toStrictEqual([
      {
        kind: 'exec',
        name: 'dev',
        request: { argv: ['sleep', '9'], tty: false, killGraceMs: 2000 },
        feature: undefined,
      },
    ]);
  },
);

// a tty's group belongs to its terminal; a session always has one
test.each([
  ['a plain tty exec', {}],
  ['a session', { session: 'main' }],
])('it refuses a kill grace for %s', (_label, extra) => {
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, buildStubExecBackend().backend);

  session.handleMessage({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: true,
    killGraceMs: 2000,
    ...extra,
  });

  expect(socket.sent).toStrictEqual([
    { type: 'error', message: expect.toInclude('a tty exec takes no kill grace') },
  ]);

  expect(socket.closes).toStrictEqual([1011]);
});

test('it refuses a session without a tty', () => {
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, buildStubExecBackend().backend);

  session.handleMessage({ type: 'start', name: 'dev', argv: ['sh'], tty: false, session: 'main' });

  expect(socket.sent).toStrictEqual([
    { type: 'error', message: expect.toInclude('a session needs a tty') },
  ]);

  expect(socket.closes).toStrictEqual([1011]);
});

// A session runs on when impd loses its agent connection (a sleep, a
// restore): the client gets a clean detach it can attach again after.
test('it detaches as lost from a session whose stream ends without an exit or a detached', async () => {
  const fake = buildStubAgentExecStream({ session: 'main', created: false });
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ attach: fake.stream }).backend,
  );

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main' });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('partial') });
  fake.drop();

  await waitFor(() => {
    expect(socket.closes).toStrictEqual([1000]);
  });

  expect(socket.sent.at(-1)).toStrictEqual({ type: 'detached', reason: 'lost' });
});

test('it reads a detach reason the agent sends that impd does not know as lost', async () => {
  const fake = buildStubAgentExecStream({ session: 'main', created: false });
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ attach: fake.stream }).backend,
  );

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main' });
  fake.emitEvent({ type: 'detached', reason: 'cosmic_rays' });

  await waitFor(() => {
    expect(socket.closes).toStrictEqual([1000]);
  });

  expect(socket.sent.at(-1)).toStrictEqual({ type: 'detached', reason: 'lost' });
});

test('it runs a tool from the system drive as root, gated on its agent feature', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, stub.backend);

  session.handleMessage({
    type: 'start',
    name: 'dev',
    tool: 'tar',
    argv: ['extract', '/srv/app'],
    tty: false,
  });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([{ type: 'started', pid: 7 }]);
  });

  expect(stub.opens).toStrictEqual([
    {
      kind: 'exec',
      name: 'dev',
      request: {
        argv: ['/run/imp/sys/imp-agent', 'tar', 'extract', '/srv/app'],
        tty: false,
        user: 'root',
      },
      feature: 'cp',
    },
  ]);
});

test('it refuses a tool with a tty as a bad message', () => {
  const socket = buildStubExecSocket();
  const stub = buildStubExecBackend();
  const session = createExecSession(socket.peer, stub.backend);

  session.handleMessage({
    type: 'start',
    name: 'dev',
    tool: 'tar',
    argv: ['create', 'x'],
    tty: true,
  });

  expect(socket.sent).toStrictEqual([
    { type: 'error', message: expect.toStartWith('bad exec message: ') },
  ]);

  expect(socket.closes).toStrictEqual([1011]);
  expect(stub.opens).toStrictEqual([]);
});

test("it acks none of a tool's stdin before the stream has it on its way", async () => {
  const fake = buildStubAgentExecStream({ stdinDrained: () => new Promise(() => {}) });
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  session.handleMessage({
    type: 'start',
    name: 'dev',
    tool: 'tar',
    argv: ['extract', 'x'],
    tty: false,
  });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([{ type: 'started', pid: 7 }]);
  });

  session.handleMessage(encodeExecFrame(EXEC_CHANNELS.stdin, new TextEncoder().encode('abc')));
  session.handleMessage(encodeExecFrame(EXEC_CHANNELS.stdin, new TextEncoder().encode('de')));

  expect(fake.input).toStrictEqual(['stdin:abc', 'stdin:de']);
  expect(socket.sent).toStrictEqual([{ type: 'started', pid: 7 }]);
});

test("it acks a tool's stdin once the stream has it on its way", async () => {
  const fake = buildStubAgentExecStream();
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  session.handleMessage({
    type: 'start',
    name: 'dev',
    tool: 'tar',
    argv: ['extract', 'x'],
    tty: false,
  });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([{ type: 'started', pid: 7 }]);
  });

  session.handleMessage(encodeExecFrame(EXEC_CHANNELS.stdin, new Uint8Array(3)));
  session.handleMessage(encodeExecFrame(EXEC_CHANNELS.stdin, new Uint8Array(2)));

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([
      { type: 'started', pid: 7 },
      { type: 'stdin_ack', bytes: 3 },
      { type: 'stdin_ack', bytes: 2 },
    ]);
  });
});

test("it takes a tool's stdin up to the window and a frame past it", async () => {
  const fake = buildStubAgentExecStream({ stdinDrained: () => new Promise(() => {}) });
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  const frames =
    (EXEC_STDIN_WINDOW_BYTES + EXEC_MAX_STDIN_FRAME_BYTES) / EXEC_MAX_STDIN_FRAME_BYTES;

  session.handleMessage({
    type: 'start',
    name: 'dev',
    tool: 'tar',
    argv: ['extract', 'x'],
    tty: false,
  });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([{ type: 'started', pid: 7 }]);
  });

  // each frame repeats its own letter, so the input shows every frame in order
  for (let index = 0; index < frames; index++) {
    session.handleMessage(
      encodeExecFrame(
        EXEC_CHANNELS.stdin,
        new Uint8Array(EXEC_MAX_STDIN_FRAME_BYTES).fill(0x61 + index),
      ),
    );
  }

  expect(socket.closes).toStrictEqual([]);

  expect(fake.input).toStrictEqual(
    Array.from(
      'abcdefghijklmnopq',
      (letter) => `stdin:${letter.repeat(EXEC_MAX_STDIN_FRAME_BYTES)}`,
    ),
  );
});

test('it cuts off a tool client that sends stdin past the window', async () => {
  const fake = buildStubAgentExecStream({ stdinDrained: () => new Promise(() => {}) });
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  const frames =
    (EXEC_STDIN_WINDOW_BYTES + EXEC_MAX_STDIN_FRAME_BYTES) / EXEC_MAX_STDIN_FRAME_BYTES;

  session.handleMessage({
    type: 'start',
    name: 'dev',
    tool: 'tar',
    argv: ['extract', 'x'],
    tty: false,
  });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([{ type: 'started', pid: 7 }]);
  });

  // each frame repeats its own letter, so the input shows every frame in order
  for (let index = 0; index < frames; index++) {
    session.handleMessage(
      encodeExecFrame(
        EXEC_CHANNELS.stdin,
        new Uint8Array(EXEC_MAX_STDIN_FRAME_BYTES).fill(0x61 + index),
      ),
    );
  }

  session.handleMessage(encodeExecFrame(EXEC_CHANNELS.stdin, new TextEncoder().encode('z')));

  expect(socket.sent.at(-1)).toStrictEqual({ type: 'error', message: 'stdin past the window' });
  expect(socket.closes).toStrictEqual([1011]);

  expect(fake.input).toStrictEqual([
    ...Array.from(
      'abcdefghijklmnopq',
      (letter) => `stdin:${letter.repeat(EXEC_MAX_STDIN_FRAME_BYTES)}`,
    ),
    'close',
  ]);
});

test("it neither acks nor windows a plain exec's stdin", async () => {
  const fake = buildStubAgentExecStream();
  const stub = buildStubExecBackend({ exec: fake.stream });
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, stub.backend);

  session.handleMessage({ type: 'start', name: 'dev', argv: ['cat'], tty: false });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([{ type: 'started', pid: 7 }]);
  });

  for (let index = 0; index < 40; index++) {
    session.handleMessage(
      encodeExecFrame(EXEC_CHANNELS.stdin, new Uint8Array(EXEC_MAX_STDIN_FRAME_BYTES)),
    );
  }

  fake.emitEvent({ type: 'exit', code: 0, signal: 0 });

  await waitFor(() => {
    expect(stub.activity).toStrictEqual(['dev']);
  });

  expect(socket.sent).toStrictEqual([
    { type: 'started', pid: 7 },
    { type: 'exit', code: 0, signal: null },
  ]);

  expect(socket.closes).toStrictEqual([1000]);
});

// all of the fed output is ready at once, so a session that did not hold
// would send every frame before the wait reads the count
test("it holds a tool's stdout once the client has not acked a window of it", async () => {
  const fake = buildStubAgentExecStream();
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  const frames = EXEC_STDOUT_WINDOW_BYTES / 65_536 + 2;

  session.handleMessage({
    type: 'start',
    name: 'dev',
    tool: 'tar',
    argv: ['create', 'x'],
    tty: false,
  });

  for (let index = 0; index < frames; index++) {
    fake.emitEvent({ type: 'stdout', data: new Uint8Array(65_536) });
  }

  await waitFor(() => {
    expect(socket.sent.filter((message) => Array.isArray(message))).toHaveLength(frames - 1);
  });
});

test("it sends a tool's held stdout once the client acks it", async () => {
  const fake = buildStubAgentExecStream();
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  const frames = EXEC_STDOUT_WINDOW_BYTES / 65_536 + 2;

  session.handleMessage({
    type: 'start',
    name: 'dev',
    tool: 'tar',
    argv: ['create', 'x'],
    tty: false,
  });

  for (let index = 0; index < frames; index++) {
    fake.emitEvent({ type: 'stdout', data: new Uint8Array(65_536) });
  }

  await waitFor(() => {
    expect(socket.sent.filter((message) => Array.isArray(message))).toHaveLength(frames - 1);
  });

  session.handleMessage({ type: 'stdout_ack', bytes: 65_536 * 2 });

  await waitFor(() => {
    expect(socket.sent.filter((message) => Array.isArray(message))).toHaveLength(frames);
  });
});

test("it sends a plain exec's stdout without waiting for acks", async () => {
  const fake = buildStubAgentExecStream();
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  const frames = EXEC_STDOUT_WINDOW_BYTES / 65_536 + 4;

  session.handleMessage({ type: 'start', name: 'dev', argv: ['cat'], tty: false });

  for (let index = 0; index < frames; index++) {
    fake.emitEvent({ type: 'stdout', data: new Uint8Array(65_536) });
  }

  await waitFor(() => {
    expect(socket.sent).toHaveLength(frames + 1);
  });
});

test('it holds the next output while the client has more than 1 MiB queued, until it drains', async () => {
  const fake = buildStubAgentExecStream();
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  socket.buffered.bytes = 2_000_000;

  session.handleMessage({ type: 'start', name: 'dev', argv: ['cat'], tty: false });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('one') });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('two') });

  // a read that saw the queue past the mark leaves the session waiting
  await waitFor(() => {
    expect(socket.buffered.reads).toBeGreaterThanOrEqual(1);
  });

  const held = [...socket.sent];

  socket.buffered.bytes = 0;

  session.handleDrain();

  await waitFor(() => {
    expect(socket.sent).toHaveLength(3);
  });

  expect(held).toStrictEqual([{ type: 'started', pid: 7 }, [EXEC_CHANNELS.stdout, 'one']]);

  expect(socket.sent).toStrictEqual([
    { type: 'started', pid: 7 },
    [EXEC_CHANNELS.stdout, 'one'],
    [EXEC_CHANNELS.stdout, 'two'],
  ]);
});

test("it places a session's data in started and gives the offset after it in the exit", async () => {
  const output = buildMockSessionOutput({ bufferStart: 0, end: 100, offset: 90, prelude: 3 });
  const fake = buildStubAgentExecStream({ session: 'main', output });
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ attach: fake.stream }).backend,
  );

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main' });

  // the 3-byte prelude, then the 10 kept bytes, then 5 live ones
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('\u001B[?0123456789') });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('abcde') });
  fake.emitEvent({ type: 'exit', code: 0, signal: 0 });

  await waitFor(() => {
    expect(socket.closes).toStrictEqual([1000]);
  });

  expect(socket.sent[0]).toStrictEqual({
    type: 'started',
    pid: 7,
    session: 'main',
    created: false,
    output,
  });

  expect(socket.sent.at(-1)).toStrictEqual({ type: 'exit', code: 0, signal: null, offset: 105 });
});

test('it detaches a session that loses the agent at the offset after its last byte', async () => {
  const output = buildMockSessionOutput({ end: 40, offset: 40, prelude: 0 });
  const fake = buildStubAgentExecStream({ session: 'main', output });
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ attach: fake.stream }).backend,
  );

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main' });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('partial') });
  fake.drop();

  await waitFor(() => {
    expect(socket.closes).toStrictEqual([1000]);
  });

  expect(socket.sent.at(-1)).toStrictEqual({ type: 'detached', reason: 'lost', offset: 47 });
});

// a dropped message would skip bytes: the socket closes, and no later byte
// goes out
test('it closes the socket and the stream when the client socket drops output', async () => {
  const fake = buildStubAgentExecStream({ session: 'main', output: buildMockSessionOutput() });
  const socket = buildStubExecSocket({ keeps: 1 });

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ attach: fake.stream }).backend,
  );

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main' });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('one') });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('two') });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('three') });

  await waitFor(() => {
    expect(socket.closes).toStrictEqual([1011]);
  });

  expect(socket.sent.slice(1)).toStrictEqual([[EXEC_CHANNELS.stdout, 'one']]);
  expect(fake.input).toContain('close');
});

test('it sends a plain exec whose output was dropped no failure after the close', async () => {
  const fake = buildStubAgentExecStream();
  const stub = buildStubExecBackend({ exec: fake.stream });
  const socket = buildStubExecSocket({ keeps: 0 });
  const session = createExecSession(socket.peer, stub.backend);

  session.handleMessage({ type: 'start', name: 'dev', argv: ['cat'], tty: false });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('partial') });
  fake.drop();

  await waitFor(() => {
    expect(stub.activity).toStrictEqual(['dev']);
  });

  expect(socket.sent).toStrictEqual([{ type: 'started', pid: 7 }]);
  expect(socket.closes).toStrictEqual([1011]);
});

test('it passes an attach its resumeFrom and wake', async () => {
  const fake = buildStubAgentExecStream({ session: 'main' });
  const stub = buildStubExecBackend({ attach: fake.stream });
  const session = createExecSession(buildStubExecSocket().peer, stub.backend);

  session.handleMessage({
    type: 'attach',
    name: 'dev',
    session: 'main',
    resumeFrom: { executionGeneration: 'a'.repeat(32), offset: 12 },
    wake: false,
  });

  await waitFor(() => {
    expect(stub.opens).toStrictEqual([
      {
        kind: 'attach',
        name: 'dev',
        request: {
          session: 'main',
          resumeFrom: { executionGeneration: 'a'.repeat(32), offset: 12 },
          wake: false,
        },
      },
    ]);
  });
});

test.each([
  ['NO_SESSION', 'no session "main"', { bootId: 'boot-1', coldBoots: [] }],
  ['INVALID_RESUME', 'offset 9 is past the end', { end: 4, bufferStart: 0 }],
])('it passes the agent error %s on with its data', async (code, message, data) => {
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ attach: new AgentError(code, message, data) }).backend,
  );

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main' });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([{ type: 'error', code, message, data }]);
  });
});

test('it sends an exec in the agent as outer, gated on its agent feature', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const session = createExecSession(buildStubExecSocket().peer, stub.backend);

  session.handleMessage({ type: 'start', name: 'dev', argv: ['sh'], tty: true, outer: true });

  await waitFor(() => {
    expect(stub.opens).toStrictEqual([
      {
        kind: 'exec',
        name: 'dev',
        request: { argv: ['sh'], tty: true, outer: true },
        feature: 'outer-exec',
      },
    ]);
  });
});

test.each([
  ['a session', { argv: ['sh'], tty: true, session: 'main' }],
  ['a tool', { argv: ['create', 'x'], tty: false, tool: 'tar' }],
])('it refuses an exec in the agent with %s as a bad message', (_label, start) => {
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, buildStubExecBackend().backend);

  session.handleMessage({ type: 'start', name: 'dev', outer: true, ...start });

  expect(socket.sent).toStrictEqual([
    { type: 'error', message: expect.toStartWith('bad exec message: ') },
  ]);
});

test("it passes a start's requirements to the backend", async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const session = createExecSession(buildStubExecSocket().peer, stub.backend);

  session.handleMessage({
    type: 'start',
    name: 'dev',
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  await waitFor(() => {
    expect(stub.opens).toStrictEqual([
      {
        kind: 'exec',
        name: 'dev',
        request: { argv: ['true'], tty: false, require: ['broker'] },
        feature: undefined,
      },
    ]);
  });
});

test("it passes the backend's refusal of a requirement on with its data", async () => {
  const data = { reason: 'broker_not_ready', detail: 'the imp has no grant' };

  const stub = buildStubExecBackend({
    exec: new ORPCError('PRECONDITION_FAILED', { message: 'not ready', data }),
  });

  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, stub.backend);

  session.handleMessage({
    type: 'start',
    name: 'dev',
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([
      { type: 'error', code: 'PRECONDITION_FAILED', message: 'not ready', data },
    ]);
  });
});

test('it sends a log to the agent', async () => {
  const fake = buildStubAgentExecStream({
    session: 'main',
    created: true,
    output: buildMockSessionOutput(),
  });

  const stub = buildStubExecBackend({ exec: fake.stream });
  const session = createExecSession(buildStubExecSocket().peer, stub.backend);

  session.handleMessage({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: true,
    session: 'main',
    log: true,
  });

  await waitFor(() => {
    expect(stub.opens).toStrictEqual([
      {
        kind: 'exec',
        name: 'dev',
        request: { argv: ['sh'], tty: true, session: 'main', log: true },
        feature: undefined,
      },
    ]);
  });
});

test('it says in started that an agent which keeps no log keeps none', async () => {
  const output = buildMockSessionOutput();
  const fake = buildStubAgentExecStream({ session: 'main', created: true, output });
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  session.handleMessage({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: true,
    session: 'main',
    log: true,
  });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([
      {
        type: 'started',
        pid: 7,
        session: 'main',
        created: true,
        output: { ...output, log: { enabled: false } },
      },
    ]);
  });
});

test("it keeps the agent's own log answer in started", async () => {
  const output = buildMockSessionOutput({ log: { enabled: true } });
  const fake = buildStubAgentExecStream({ session: 'main', created: true, output });
  const socket = buildStubExecSocket();

  const session = createExecSession(
    socket.peer,
    buildStubExecBackend({ exec: fake.stream }).backend,
  );

  session.handleMessage({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: true,
    session: 'main',
    log: true,
  });

  await waitFor(() => {
    expect(socket.sent).toStrictEqual([
      { type: 'started', pid: 7, session: 'main', created: true, output },
    ]);
  });
});

test('it refuses a log without a session as a bad message', () => {
  const socket = buildStubExecSocket();
  const session = createExecSession(socket.peer, buildStubExecBackend().backend);

  session.handleMessage({ type: 'start', name: 'dev', argv: ['sh'], tty: true, log: true });

  expect(socket.sent).toStrictEqual([
    { type: 'error', message: expect.toStartWith('bad exec message: ') },
  ]);
});
