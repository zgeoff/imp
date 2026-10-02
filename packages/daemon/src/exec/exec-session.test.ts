import { expect, test } from 'bun:test';
import {
  EXEC_CHANNELS,
  EXEC_MAX_STDIN_FRAME_BYTES,
  EXEC_STDIN_WINDOW_BYTES,
  EXEC_STDOUT_WINDOW_BYTES,
  decodeExecFrame,
  encodeExecFrame,
} from '@imp/api';
import type { SessionOutput } from '@imp/api';
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
    groupKill: false,
    output: null,
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

// `drops` binary messages after the first `keeps`, as a socket over its
// backpressure limit does
function buildFakePeer(keeps = Infinity) {
  const sent: unknown[] = [];
  const closes: number[] = [];
  const binary = { count: 0 };

  return {
    sent,
    closes,
    peer: {
      sendText: (text: string) => {
        sent.push(JSON.parse(text));
      },
      sendBinary: (data: Uint8Array) => {
        binary.count += 1;

        if (binary.count > keeps) {
          return false;
        }

        const frame = decodeExecFrame(data);

        sent.push([frame.channel, new TextDecoder().decode(frame.data)]);

        return true;
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
    { type: 'started', pid: 7, session: 'main', created: false, output: { continuity: 'none' } },
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

  expect(peer.sent).toEqual([
    { type: 'started', pid: 7, session: 'main', created: true, output: { continuity: 'none' } },
  ]);
});

test('a kill grace goes to the agent, and started says whether it kills the group', async () => {
  for (const groupKill of [true, false]) {
    const fake = buildFakeStream();
    const peer = buildFakePeer();
    const requests: AgentExecRequest[] = [];

    const session = createExecSession(
      peer.peer,
      buildBackend({
        openExec: (_name, request) => {
          requests.push(request);

          return Promise.resolve({ ...fake.stream, groupKill });
        },
      }),
    );

    session.handleMessage({
      type: 'start',
      name: 'dev',
      argv: ['sleep', '9'],
      tty: false,
      killGraceMs: 2000,
    });

    await Bun.sleep(5);

    expect(requests).toEqual([{ argv: ['sleep', '9'], tty: false, killGraceMs: 2000 }]);
    expect(peer.sent).toEqual([{ type: 'started', pid: 7, groupKill }]);
  }
});

// a tty's group belongs to its terminal; a session always has one
test('it refuses a kill grace with a tty', () => {
  for (const extra of [{}, { session: 'main' }]) {
    const peer = buildFakePeer();
    const session = createExecSession(peer.peer, buildBackend({}));

    session.handleMessage({
      type: 'start',
      name: 'dev',
      argv: ['sh'],
      tty: true,
      killGraceMs: 2000,
      ...extra,
    });

    expect(JSON.stringify(peer.sent[0])).toContain('a tty exec takes no kill grace');
    expect(peer.closes).toEqual([1011]);
  }
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

test("a tool's stdout waits for the client's acks past the window", async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();

  const session = createExecSession(
    peer.peer,
    buildBackend({ openExec: () => Promise.resolve(fake.stream) }),
  );

  session.handleMessage({
    type: 'start',
    name: 'dev',
    tool: 'tar',
    argv: ['create', 'x'],
    tty: false,
  });

  await Bun.sleep(5);

  const chunk = 65_536;
  const frames = EXEC_STDOUT_WINDOW_BYTES / chunk + 2;

  for (let index = 0; index < frames; index++) {
    fake.emitEvent({ type: 'stdout', data: new Uint8Array(chunk) });
  }

  await Bun.sleep(5);

  const countStdout = (): number =>
    peer.sent.filter((message) => Array.isArray(message) && message[0] === EXEC_CHANNELS.stdout)
      .length;

  expect(countStdout()).toBe(frames - 1);

  session.handleMessage({ type: 'stdout_ack', bytes: chunk * 2 });

  await Bun.sleep(5);

  expect(countStdout()).toBe(frames);
});

test("a plain exec's stdout does not wait for acks", async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();

  const session = createExecSession(
    peer.peer,
    buildBackend({ openExec: () => Promise.resolve(fake.stream) }),
  );

  session.handleMessage({ type: 'start', name: 'dev', argv: ['cat'], tty: false });

  await Bun.sleep(5);

  const frames = EXEC_STDOUT_WINDOW_BYTES / 65_536 + 4;

  for (let index = 0; index < frames; index++) {
    fake.emitEvent({ type: 'stdout', data: new Uint8Array(65_536) });
  }

  await Bun.sleep(5);

  expect(peer.sent).toHaveLength(frames + 1);
});

const GENERATION = 'a'.repeat(32);

// a session whose agent counts output: a fresh attach with a 3-byte prelude
const OFFSETS_OUTPUT: SessionOutput = {
  continuity: 'offsets',
  bootId: 'boot-1',
  executionGeneration: GENERATION,
  bufferStart: 0,
  end: 100,
  offset: 90,
  prelude: 3,
  coldBoots: [{ bootId: 'boot-1', cause: 'start', at: '2026-10-03T00:00:00.000Z' }],
};

test('a session with offsets: started places the data, and exit gives the offset after it', async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();
  const stream: ExecStream = { ...fake.stream, session: 'main', output: OFFSETS_OUTPUT };

  const session = createExecSession(
    peer.peer,
    buildBackend({ openAttach: () => Promise.resolve(stream) }),
  );

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main' });

  await Bun.sleep(5);

  // the prelude, then the 10 kept bytes, then 5 live ones
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('\u001B[?0123456789') });
  fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode('abcde') });
  fake.emitEvent({ type: 'exit', code: 0, signal: 0 });

  await Bun.sleep(5);

  expect(peer.sent[0]).toEqual({
    type: 'started',
    pid: 7,
    session: 'main',
    created: false,
    output: OFFSETS_OUTPUT,
  });

  expect(peer.sent.at(-1)).toEqual({ type: 'exit', code: 0, signal: null, offset: 105 });
});

test('a session that loses the agent ends with detached at its offset', async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();

  const stream: ExecStream = {
    ...fake.stream,
    session: 'main',
    output: { ...OFFSETS_OUTPUT, offset: 40, prelude: 0 },
    events: readWithoutExit,
  };

  const session = createExecSession(
    peer.peer,
    buildBackend({ openAttach: () => Promise.resolve(stream) }),
  );

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main' });

  await Bun.sleep(10);

  expect(peer.sent.at(-1)).toEqual({ type: 'detached', reason: 'lost', offset: 47 });
  expect(peer.closes).toEqual([1000]);
});

// a dropped message would skip bytes: the socket closes, and no later byte
// goes out
test('it closes the socket when the peer drops output', async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer(1);
  const stream: ExecStream = { ...fake.stream, session: 'main', output: OFFSETS_OUTPUT };

  const session = createExecSession(
    peer.peer,
    buildBackend({ openAttach: () => Promise.resolve(stream) }),
  );

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main' });

  await Bun.sleep(5);

  for (const chunk of ['one', 'two', 'three']) {
    fake.emitEvent({ type: 'stdout', data: new TextEncoder().encode(chunk) });
  }

  await Bun.sleep(5);

  expect(peer.sent.slice(1)).toEqual([[EXEC_CHANNELS.stdout, 'one']]);
  expect(peer.closes).toEqual([1011]);
  expect(fake.input).toContain('close');
});

test('an attach passes resumeFrom and wake to the backend', async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer();
  const requests: AgentAttachRequest[] = [];

  const session = createExecSession(
    peer.peer,
    buildBackend({
      openAttach: (_name, request) => {
        requests.push(request);

        return Promise.resolve({ ...fake.stream, session: 'main' });
      },
    }),
  );

  const resumeFrom = { executionGeneration: GENERATION, offset: 12 };

  session.handleMessage({ type: 'attach', name: 'dev', session: 'main', resumeFrom, wake: false });

  await Bun.sleep(5);

  expect(requests).toEqual([{ session: 'main', resumeFrom, wake: false }]);
});

test('NO_SESSION and INVALID_RESUME keep their data', async () => {
  const errors = [
    ['NO_SESSION', 'no session "main"', { bootId: 'boot-1', coldBoots: [] }],
    ['INVALID_RESUME', 'offset 9 is past the end', { end: 4, bufferStart: 0 }],
  ] as const;

  for (const [code, message, data] of errors) {
    const peer = buildFakePeer();

    const session = createExecSession(
      peer.peer,
      buildBackend({ openAttach: () => Promise.reject(new AgentError(code, message, data)) }),
    );

    session.handleMessage({ type: 'attach', name: 'dev', session: 'main' });

    await Bun.sleep(5);

    expect(peer.sent).toEqual([{ type: 'error', code, message, data }]);
  }
});

test('a plain exec whose output was dropped sends no failure after the close', async () => {
  const fake = buildFakeStream();
  const peer = buildFakePeer(0);
  const stream: ExecStream = { ...fake.stream, events: readWithoutExit };

  const session = createExecSession(
    peer.peer,
    buildBackend({ openExec: () => Promise.resolve(stream) }),
  );

  session.handleMessage({ type: 'start', name: 'dev', argv: ['cat'], tty: false });

  await Bun.sleep(10);

  expect(peer.sent).toEqual([{ type: 'started', pid: 7 }]);
  expect(peer.closes).toEqual([1011]);
});
