import { expect, test } from 'bun:test';
import {
  EXEC_CHANNELS,
  EXEC_MAX_STDIN_FRAME_BYTES,
  EXEC_STDIN_WINDOW_BYTES,
  decodeExecFrame,
  encodeExecFrame,
} from '@imp/api';
import { ORPCError } from '@orpc/server';
import * as z from 'zod';
import { AgentError } from '../agent-client/agent-connection';
import type {
  AgentAttachRequest,
  AgentExecRequest,
  ExecEvent,
  ExecStream,
} from '../agent-client/exec-stream';
import { createExecSession } from './exec-session';
import type { ExecBackend } from './exec-session';

interface EventSource {
  readonly next: () => Promise<ExecEvent>;
}

// one output chunk, then the connection drops
async function* readWithoutExit(): AsyncGenerator<ExecEvent, void, undefined> {
  await Bun.sleep(1);

  yield { type: 'stdout', data: new TextEncoder().encode('partial') };
}

async function* readUntilEnd(source: EventSource): AsyncGenerator<ExecEvent, void, undefined> {
  for (;;) {
    const event = await source.next();

    yield event;

    if (event.type === 'exit' || event.type === 'detached') {
      return;
    }
  }
}

// an exec stream whose events the test feeds and whose input it records
function buildFakeStream() {
  const queue: ExecEvent[] = [];
  const input: string[] = [];
  const waiting: { wake: (() => void) | null } = { wake: null };

  const emitEvent = (event: ExecEvent): void => {
    queue.push(event);
    waiting.wake?.();
  };

  const source: EventSource = {
    next: async () => {
      for (;;) {
        const event = queue.shift();

        if (event !== undefined) {
          return event;
        }

        await new Promise<void>((resolve) => {
          waiting.wake = resolve;
        });
      }
    },
  };

  const stream: ExecStream = {
    pid: 7,
    session: null,
    created: false,
    writeStdin: (data) => {
      input.push(`stdin:${new TextDecoder().decode(data)}`);
    },
    stdinDrained: () => Promise.resolve(),
    closeStdin: () => {
      input.push('eof');
    },
    resize: (cols, rows) => {
      input.push(`resize:${String(cols)}x${String(rows)}`);
    },
    sendSignal: (signal) => {
      input.push(`signal:${String(signal)}`);
    },
    events: () => readUntilEnd(source),
    close: () => {
      input.push('close');
    },
  };

  return { stream, input, emitEvent };
}

// the backend a test passes, with the parts it leaves out failing
function buildBackend(backend: Partial<ExecBackend>): ExecBackend {
  return {
    openExec: () => Promise.reject(new Error('unused')),
    openAttach: () => Promise.reject(new Error('unused')),
    recordActivity: () => Promise.resolve(),
    ...backend,
  };
}

function buildFakePeer() {
  const sent: unknown[] = [];
  const closes: number[] = [];

  return {
    sent,
    closes,
    peer: {
      sendText: (text: string) => {
        sent.push(JSON.parse(text));
      },
      sendBinary: (data: Uint8Array) => {
        const frame = decodeExecFrame(data);

        sent.push([frame.channel, new TextDecoder().decode(frame.data)]);
      },
      close: (code = 1000) => {
        closes.push(code);
      },
      readBufferedAmount: () => 0,
    },
  };
}

test('it bridges a WebSocket to an agent exec stream', async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();
  const requests: AgentExecRequest[] = [];

  const session = createExecSession(
    peer.peer,
    buildBackend({
      openExec: (_name, request) => {
        requests.push(request);

        return Promise.resolve(fake.stream);
      },
    }),
  );

  session.handleMessage({
    type: 'start',
    name: 'dev',
    argv: ['sh'],
    tty: true,
    env: { TERM: 'xterm' },
    cols: 100,
    rows: 30,
  });

  // input before `started` waits for the stream
  session.handleMessage(encodeExecFrame(EXEC_CHANNELS.stdin, new TextEncoder().encode('ls\n')));
  session.handleMessage({ type: 'resize', cols: 120, rows: 40 });
  session.handleMessage({ type: 'signal', signal: 'SIGINT' });
  session.handleMessage({ type: 'stdin_eof' });

  await Bun.sleep(5);

  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('out') });
  fake.emitEvent({ type: 'exit', code: 137, signal: 9 });

  await Bun.sleep(5);

  expect(requests).toEqual([{ argv: ['sh'], tty: true, env: ['TERM=xterm'], cols: 100, rows: 30 }]);
  expect(fake.input).toEqual(['stdin:ls\n', 'resize:120x40', 'signal:2', 'eof', 'close']);

  expect(peer.sent).toEqual([
    { type: 'started', pid: 7 },
    [EXEC_CHANNELS.stdout, 'out'],
    { type: 'exit', code: null, signal: 'SIGKILL' },
  ]);

  expect(peer.closes).toEqual([1000]);
});

test('it reports an exec that cannot start and closes the socket', async () => {
  const peer = buildFakePeer();

  const session = createExecSession(
    peer.peer,
    buildBackend({
      openExec: () => Promise.reject(new AgentError('EXEC_FAILED', 'no such file')),
    }),
  );

  session.handleMessage({ type: 'start', name: 'dev', argv: ['nope'], tty: false });

  await Bun.sleep(5);

  expect(peer.sent).toEqual([{ type: 'error', code: 'EXEC_FAILED', message: 'no such file' }]);
  expect(peer.closes).toEqual([1011]);
});

test('it passes a contract error on with its data', async () => {
  const peer = buildFakePeer();
  const data = { budgetMib: 1024, usedMib: 900, requestedMib: 512 };

  const session = createExecSession(
    peer.peer,
    buildBackend({
      openExec: () =>
        Promise.reject(new ORPCError('RAM_BUDGET_EXCEEDED', { message: 'no room', data })),
    }),
  );

  session.handleMessage({ type: 'start', name: 'dev', argv: ['sh'], tty: false });

  await Bun.sleep(5);

  expect(peer.sent).toEqual([
    { type: 'error', code: 'RAM_BUDGET_EXCEEDED', message: 'no room', data },
  ]);
});

test('it rejects a control message before start', () => {
  const peer = buildFakePeer();

  const session = createExecSession(
    peer.peer,
    buildBackend({
      openExec: () => Promise.reject(new Error('unused')),
    }),
  );

  session.handleMessage({ type: 'resize', cols: 1, rows: 1 });

  expect(peer.sent).toEqual([{ type: 'error', message: 'resize before start' }]);
});

test('it closes with 1011 when the stream ends without an exit', async () => {
  const peer = buildFakePeer();
  const stream: ExecStream = { ...buildFakeStream().stream, events: readWithoutExit };

  const session = createExecSession(
    peer.peer,
    buildBackend({
      openExec: () => Promise.resolve(stream),
    }),
  );

  session.handleMessage({ type: 'start', name: 'dev', argv: ['cat'], tty: false });

  await Bun.sleep(10);

  expect(peer.closes).toEqual([1011]);
});

test('it reports a malformed binary frame instead of throwing', async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();

  const session = createExecSession(
    peer.peer,
    buildBackend({
      openExec: () => Promise.resolve(fake.stream),
    }),
  );

  session.handleMessage({ type: 'start', name: 'dev', argv: ['cat'], tty: false });

  await Bun.sleep(5);

  session.handleMessage(new Uint8Array([]));

  expect(peer.closes).toEqual([1011]);
});

test('it attaches to a session and ends with detached when taken over', async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();
  const requests: AgentAttachRequest[] = [];
  const stream: ExecStream = { ...fake.stream, session: 'main', created: false };

  const session = createExecSession(
    peer.peer,
    buildBackend({
      openAttach: (_name, request) => {
        requests.push(request);

        return Promise.resolve(stream);
      },
    }),
  );

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main', cols: 100, rows: 30 });

  await Bun.sleep(5);

  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('replay') });
  fake.emitEvent({ type: 'detached', reason: 'taken_over' });

  await Bun.sleep(5);

  expect(requests).toEqual([{ session: 'main', cols: 100, rows: 30 }]);

  expect(peer.sent).toEqual([
    { type: 'started', pid: 7, session: 'main', created: false },
    [EXEC_CHANNELS.stdout, 'replay'],
    { type: 'detached', reason: 'taken_over' },
  ]);

  expect(peer.closes).toEqual([1000]);
});

test('it starts a named session', async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();
  const requests: AgentExecRequest[] = [];
  const stream: ExecStream = { ...fake.stream, session: 'main', created: true };

  const session = createExecSession(
    peer.peer,
    buildBackend({
      openExec: (_name, request) => {
        requests.push(request);

        return Promise.resolve(stream);
      },
    }),
  );

  session.handleMessage({ type: 'start', name: 'dev', argv: ['sh'], tty: true, session: 'main' });

  await Bun.sleep(5);

  expect(requests).toEqual([{ argv: ['sh'], tty: true, session: 'main' }]);
  expect(peer.sent).toEqual([{ type: 'started', pid: 7, session: 'main', created: true }]);
});

test('it refuses a session without a tty', () => {
  const peer = buildFakePeer();
  const session = createExecSession(peer.peer, buildBackend({}));

  session.handleMessage({ type: 'start', name: 'dev', argv: ['sh'], tty: false, session: 'main' });

  expect(peer.sent).toHaveLength(1);
  expect(JSON.stringify(peer.sent[0])).toContain('a session needs a tty');
  expect(peer.closes).toEqual([1011]);
});

// A session runs on when impd loses its agent connection (a sleep, a
// restore): the client gets a clean detach it can attach again after.
test('a session stream that ends without exit or detached is a lost detach', async () => {
  const peer = buildFakePeer();

  const stream: ExecStream = {
    ...buildFakeStream().stream,
    session: 'main',
    created: false,
    events: readWithoutExit,
  };

  const session = createExecSession(
    peer.peer,
    buildBackend({ openAttach: () => Promise.resolve(stream) }),
  );

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main' });

  await Bun.sleep(10);

  expect(peer.sent.at(-1)).toEqual({ type: 'detached', reason: 'lost' });
  expect(peer.closes).toEqual([1000]);
});

test('an unknown detach reason from the agent reads as lost', async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();
  const stream: ExecStream = { ...fake.stream, session: 'main', created: false };

  const session = createExecSession(
    peer.peer,
    buildBackend({ openAttach: () => Promise.resolve(stream) }),
  );

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main' });

  await Bun.sleep(5);

  fake.emitEvent({ type: 'detached', reason: 'cosmic_rays' });

  await Bun.sleep(5);

  expect(peer.sent.at(-1)).toEqual({ type: 'detached', reason: 'lost' });
});

function encodeStdin(size: number): Uint8Array {
  return encodeExecFrame(EXEC_CHANNELS.stdin, new Uint8Array(size));
}

test('a tool runs from the system drive as root, gated on its agent feature', async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();
  const opened: unknown[] = [];

  const session = createExecSession(
    peer.peer,
    buildBackend({
      openExec: (name, request, feature) => {
        opened.push({ name, request, feature });

        return Promise.resolve(fake.stream);
      },
    }),
  );

  session.handleMessage({
    type: 'start',
    name: 'dev',
    tool: 'tar',
    argv: ['extract', '/srv/app'],
    tty: false,
  });

  await Bun.sleep(5);

  expect(opened).toEqual([
    {
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

test('a tool with a tty is a bad message', async () => {
  const peer = buildFakePeer();
  const session = createExecSession(peer.peer, buildBackend({}));

  session.handleMessage({
    type: 'start',
    name: 'dev',
    tool: 'tar',
    argv: ['create', 'x'],
    tty: true,
  });

  await Bun.sleep(5);

  expect(peer.sent).toEqual([expect.objectContaining({ type: 'error' })]);
  expect(peer.closes).toEqual([1011]);
});

test("a tool's stdin is acked once it is on its way to the guest", async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();
  const drained = { gate: Promise.withResolvers<void>() };
  const stream: ExecStream = { ...fake.stream, stdinDrained: () => drained.gate.promise };

  const session = createExecSession(
    peer.peer,
    buildBackend({ openExec: () => Promise.resolve(stream) }),
  );

  session.handleMessage({
    type: 'start',
    name: 'dev',
    tool: 'tar',
    argv: ['extract', 'x'],
    tty: false,
  });

  await Bun.sleep(5);

  session.handleMessage(encodeStdin(3));
  session.handleMessage(encodeStdin(2));

  await Bun.sleep(5);

  expect(peer.sent).toEqual([{ type: 'started', pid: 7 }]);

  drained.gate.resolve();

  await Bun.sleep(5);

  const acked = peer.sent
    .slice(1)
    .map((message) => z.object({ bytes: z.number() }).parse(message).bytes)
    .reduce((total, bytes) => total + bytes, 0);

  expect(acked).toBe(5);
});

test('a tool client past the stdin window is cut off', async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();
  const stream: ExecStream = { ...fake.stream, stdinDrained: () => new Promise(() => {}) };

  const session = createExecSession(
    peer.peer,
    buildBackend({ openExec: () => Promise.resolve(stream) }),
  );

  session.handleMessage({
    type: 'start',
    name: 'dev',
    tool: 'tar',
    argv: ['extract', 'x'],
    tty: false,
  });

  await Bun.sleep(5);

  const frames =
    (EXEC_STDIN_WINDOW_BYTES + EXEC_MAX_STDIN_FRAME_BYTES) / EXEC_MAX_STDIN_FRAME_BYTES;

  for (let index = 0; index < frames; index++) {
    session.handleMessage(encodeStdin(EXEC_MAX_STDIN_FRAME_BYTES));
  }

  expect(peer.closes).toEqual([]);

  session.handleMessage(encodeStdin(1));

  expect(peer.sent.at(-1)).toMatchObject({ type: 'error', message: 'stdin past the window' });
  expect(peer.closes).toEqual([1011]);
  expect(fake.input.filter((entry) => entry.startsWith('stdin:'))).toHaveLength(frames);
});

test("a plain exec's stdin is not acked or windowed", async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();

  const session = createExecSession(
    peer.peer,
    buildBackend({ openExec: () => Promise.resolve(fake.stream) }),
  );

  session.handleMessage({ type: 'start', name: 'dev', argv: ['cat'], tty: false });

  await Bun.sleep(5);

  for (let index = 0; index < 40; index++) {
    session.handleMessage(encodeStdin(EXEC_MAX_STDIN_FRAME_BYTES));
  }

  await Bun.sleep(5);

  expect(peer.sent).toEqual([{ type: 'started', pid: 7 }]);
  expect(peer.closes).toEqual([]);
});
