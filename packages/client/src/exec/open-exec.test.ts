import { expect, test } from 'bun:test';
import { CONSOLE_SHELL } from '@imp/api';
import type { SessionOutput } from '@imp/api';
import { AgentError } from '@imp/daemon/src/agent-client/agent-connection';
import type {
  AgentAttachRequest,
  AgentExecRequest,
  ExecEvent,
  ExecStream,
} from '@imp/daemon/src/agent-client/exec-stream';
import { TEST_TOKEN, buildTestApp, setupImpTest } from '@imp/daemon/src/imps/test-imps';
import { ORPCError } from '@orpc/client';
import { createImpClient } from '../create-imp-client';
import { ExecError } from './exec-error';
import { InvalidResumeError } from './invalid-resume-error';
import { InvalidStateError } from './invalid-state-error';
import { NoSessionError } from './no-session-error';
import { openExecSession } from './open-exec-session';
import { toExecError } from './to-exec-error';

const BIG_BYTES = 512 * 1024;
const GENERATION = 'd'.repeat(32);
const COLD_BOOT = { bootId: 'boot-2', cause: 'recovery', at: '2026-10-03T00:00:00.000Z' } as const;

const COUNTED_OUTPUT: SessionOutput = {
  continuity: 'offsets',
  bootId: 'boot-2',
  executionGeneration: GENERATION,
  bufferStart: 0,
  end: 100,
  offset: 95,
  prelude: 0,
  coldBoots: [COLD_BOOT],
  resume: { kind: 'exact' },
};

// A guest agent for the fake VMs, by argv[0]: `cat` echoes stdin until EOF,
// `fail` exits 3, `big` floods both streams, `tick` writes once, and `tick`,
// `wait` or the console's shell runs until a signal or ^C or impd closes it.
function buildFakeAgent() {
  const requests: AgentExecRequest[] = [];
  const input: string[] = [];

  // the commands whose stream impd closed: the client went away
  const closed: string[] = [];

  const openExec = (_name: string, request: Readonly<AgentExecRequest>): Promise<ExecStream> => {
    requests.push(request);

    if (request.argv[0] === 'nope') {
      return Promise.reject(new AgentError('EXEC_FAILED', 'no such file'));
    }

    if (request.argv[0] === 'full') {
      return Promise.reject(
        new ORPCError('RAM_BUDGET_EXCEEDED', {
          message: 'no room',
          data: { budgetMib: 1024, usedMib: 900, requestedMib: 512 },
        }),
      );
    }

    const command = request.argv[0] ?? '';

    const stream = buildScriptedStream(command, (entry) => {
      input.push(entry);
    });

    return Promise.resolve({
      ...stream,
      session: request.session ?? null,
      created: request.session !== undefined,

      // an agent that runs `old` predates the group kill
      groupKill: request.killGraceMs !== undefined && command !== 'old',
      close: () => {
        closed.push(command);
      },
    });
  };

  // `main` runs: its replay, then `taken` detaches the attach as another
  // client would; any other session is not there
  const attaches: AgentAttachRequest[] = [];

  const openAttach = (
    _name: string,
    request: Readonly<AgentAttachRequest>,
  ): Promise<ExecStream> => {
    attaches.push(request);

    if (request.wake === false) {
      return Promise.reject(
        new ORPCError('INVALID_STATE', {
          message: 'cannot attach without a wake to an imp that is sleeping',
          data: { state: 'sleeping', allowed: ['running'], coldBoots: [COLD_BOOT] },
        }),
      );
    }

    if ((request.resumeFrom?.offset ?? 0) > 100) {
      return Promise.reject(
        new AgentError('INVALID_RESUME', 'past the end', { end: 100, bufferStart: 0 }),
      );
    }

    if (request.session === 'counted') {
      return Promise.resolve({
        ...buildScriptedStream('counted', (entry) => {
          input.push(entry);
        }),
        session: 'counted',
        output: COUNTED_OUTPUT,
      });
    }

    if (request.session === 'ended') {
      return Promise.reject(
        new AgentError('NO_SESSION', 'no session "ended"', {
          bootId: 'boot-2',
          coldBoots: [COLD_BOOT],
          previous: { executionGeneration: GENERATION, end: 100, exitCode: 0 },
        }),
      );
    }

    if (request.session !== 'main') {
      return Promise.reject(new AgentError('NO_SESSION', `no session "${request.session}"`));
    }

    const stream = buildScriptedStream('attach', (entry) => {
      input.push(entry);
    });

    return Promise.resolve({
      ...stream,
      session: 'main',
      created: false,
      close: () => {
        closed.push('attach main');
      },
    });
  };

  return { openExec, openAttach, requests, attaches, input, closed };
}

interface EventQueue {
  readonly events: ExecEvent[];
  wake: (() => void) | null;
}

function buildScriptedStream(command: string, record: (entry: string) => void): ExecStream {
  const queue: EventQueue = { events: [], wake: null };

  const encoder = new TextEncoder();

  const emitEvent = (event: ExecEvent): void => {
    queue.events.push(event);
    queue.wake?.();
  };

  const emitText = (type: 'stdout' | 'stderr', text: string): void => {
    emitEvent({ type, data: encoder.encode(text) });
  };

  if (command === 'fail') {
    emitText('stdout', 'out');
    emitText('stderr', 'err');
    emitEvent({ type: 'exit', code: 3, signal: 0 });
  }

  if (command === 'attach') {
    emitText('stdout', 'replay');
  }

  if (command === 'tick') {
    emitText('stdout', 'tick');
  }

  // a resume: the tail after offset 95, then the exit
  if (command === 'counted') {
    emitText('stdout', 'tail!');
    emitEvent({ type: 'exit', code: 0, signal: 0 });
  }

  if (command === 'big') {
    for (let sent = 0; sent < BIG_BYTES; sent += 16_384) {
      emitEvent({ type: 'stdout', data: new Uint8Array(16_384).fill(111) });
      emitEvent({ type: 'stderr', data: new Uint8Array(16_384).fill(101) });
    }

    emitEvent({ type: 'exit', code: 0, signal: 0 });
  }

  const waitForEvent = async (): Promise<ExecEvent> => {
    for (;;) {
      const event = queue.events.shift();

      if (event !== undefined) {
        return event;
      }

      await new Promise<void>((resolve) => {
        queue.wake = resolve;
      });
    }
  };

  return {
    pid: 42,
    session: null,
    created: false,
    groupKill: false,
    output: null,
    writeStdin: (data) => {
      const text = new TextDecoder().decode(data);

      record(text);

      if (command === 'cat') {
        emitText('stdout', text);
      }

      if ((command === 'wait' || command === '/bin/sh') && text.includes('\u0003')) {
        emitEvent({ type: 'exit', code: 130, signal: 2 });
      }

      if (command === 'attach' && text === 'taken') {
        emitEvent({ type: 'detached', reason: 'taken_over' });
      }
    },
    stdinDrained: () => Promise.resolve(),
    closeStdin: () => {
      record('eof');

      if (command === 'cat') {
        emitEvent({ type: 'exit', code: 0, signal: 0 });
      }
    },
    resize: (cols, rows) => {
      record(`resize:${String(cols)}x${String(rows)}`);
    },
    sendSignal: (signal) => {
      record(`signal:${String(signal)}`);
      emitEvent({ type: 'exit', code: 128 + signal, signal });
    },
    events: () => readUntilExit(waitForEvent),
    close: () => {},
  };
}

async function* readUntilExit(
  next: () => Promise<ExecEvent>,
): AsyncGenerator<ExecEvent, void, undefined> {
  for (;;) {
    const event = await next();

    yield event;

    if (event.type === 'exit' || event.type === 'detached') {
      return;
    }
  }
}

// impd's app on a real port, with the fake agent, and a client that opens
// `/exec` with a ticket and no header, as a browser or Node does
async function setupExecTest() {
  const harness = await setupImpTest();

  const agent = buildFakeAgent();

  const built = buildTestApp(harness, harness, TEST_TOKEN, {
    openExec: agent.openExec,
    openAttach: agent.openAttach,
  });

  const server = built.app.listen(0);
  const port = String(server.server?.port);
  const client = createImpClient({ url: `http://127.0.0.1:${port}`, token: TEST_TOKEN });

  await harness.createTestImage('ubuntu');
  await client.imps.create({ name: 'dev' });

  return {
    ...harness,
    ...agent,
    client,
    url: `http://127.0.0.1:${port}`,
    closeExecSessions: built.closeExecSessions,
    async [Symbol.asyncDispose]() {
      await server.stop(true);
      await harness[Symbol.asyncDispose]();
    },
  };
}

const decoder = new TextDecoder();

test('run collects both streams and the exit code', async () => {
  await using ctx = await setupExecTest();

  const result = await ctx.client.run('dev', ['fail']);

  expect(result.code).toBe(3);
  expect(result.signal).toBeNull();
  expect(decoder.decode(result.stdout)).toBe('out');
  expect(decoder.decode(result.stderr)).toBe('err');
});

test('run sends stdin, closes it, and drains both streams at once', async () => {
  await using ctx = await setupExecTest();

  const echoed = await ctx.client.run('dev', ['cat'], { stdin: 'hello', cwd: '/srv' });
  const flood = await ctx.client.run('dev', ['big']);

  expect(decoder.decode(echoed.stdout)).toBe('hello');
  expect(ctx.input.slice(0, 2)).toEqual(['hello', 'eof']);
  expect(ctx.requests[0]).toMatchObject({ argv: ['cat'], tty: false, cwd: '/srv' });
  expect([flood.stdout.byteLength, flood.stderr.byteLength]).toEqual([BIG_BYTES, BIG_BYTES]);
});

test('openExec streams stdout as the command writes it', async () => {
  await using ctx = await setupExecTest();

  const handle = await ctx.client.openExec('dev', ['cat']);

  const reader = handle.stdout.getReader();

  await handle.write('one');

  const first = await reader.read();

  await handle.write(new TextEncoder().encode('two'));

  const second = await reader.read();

  await handle.closeStdin();

  const exit = await handle.exit;
  const started = await handle.started;

  expect([decoder.decode(first.value), decoder.decode(second.value)]).toEqual(['one', 'two']);
  expect(exit).toEqual({ code: 0, signal: null });
  expect(started.pid).toBe(42);
});

test('openConsole opens a login shell with a tty, and ^C goes as a key', async () => {
  await using ctx = await setupExecTest();

  const shell = await ctx.client.openConsole('dev', { cols: 100, rows: 30 });

  await shell.started;

  shell.resize(120, 40);
  shell.sendSignal('SIGINT');

  const exit = await shell.exit;

  expect(ctx.requests[0]).toMatchObject({
    argv: ['/bin/sh', '-c', CONSOLE_SHELL],
    tty: true,
    env: ['TERM=xterm-256color'],
    cols: 100,
    rows: 30,
  });

  expect(ctx.input).toEqual(['resize:120x40', '\u0003']);
  expect(exit).toEqual({ code: null, signal: 'SIGINT' });
});

test('without a tty, a signal goes as a signal', async () => {
  await using ctx = await setupExecTest();

  const handle = await ctx.client.openExec('dev', ['wait']);

  await handle.started;

  handle.sendSignal('SIGTERM');

  const exit = await handle.exit;

  expect(ctx.input).toEqual(['signal:15']);
  expect(exit).toEqual({ code: null, signal: 'SIGTERM' });
});

test('an exec error keeps impd code and data', async () => {
  await using ctx = await setupExecTest();

  const notStarted = await ctx.client.run('dev', ['nope']).catch((error: unknown) => error);
  const noRoom = await ctx.client.run('dev', ['full']).catch((error: unknown) => error);
  const noImp = await ctx.client.run('ghost', ['cat']).catch((error: unknown) => error);

  expect(notStarted).toBeInstanceOf(ExecError);
  expect(notStarted).toMatchObject({ code: 'EXEC_FAILED' });

  expect(noRoom).toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: { budgetMib: 1024, usedMib: 900, requestedMib: 512 },
  });

  // the ticket is refused before any socket opens
  expect(noImp).toBeInstanceOf(ORPCError);
  expect(noImp).toMatchObject({ code: 'NOT_FOUND' });
});

test('a session impd closes for a restart is RESTARTING', async () => {
  await using ctx = await setupExecTest();

  const handle = await ctx.client.openExec('dev', ['wait']);

  await handle.started;

  ctx.closeExecSessions();

  const rejection = await handle.exit.catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'RESTARTING' });
});

test('close and an abort end the session and the streams', async () => {
  await using ctx = await setupExecTest();

  const closed = await ctx.client.openExec('dev', ['wait']);

  await closed.started;

  closed.close();

  const abort = new AbortController();

  const aborted = await ctx.client.openExec('dev', ['wait'], { signal: abort.signal });

  await aborted.started;

  abort.abort();

  const closedExit = await closed.exit.catch((error: unknown) => error);
  const abortedExit = await aborted.exit.catch((error: unknown) => error);
  const rest = await closed.stdout.getReader().read();

  expect(closedExit).toMatchObject({ code: 'CLOSED' });
  expect(abortedExit).toMatchObject({ code: 'CLOSED' });
  expect(rest.done).toBeTrue();
});

test('an abort during the connect rejects with an AbortError, as one during the ticket call does', async () => {
  await using ctx = await setupExecTest();

  const abort = new AbortController();

  const handle = await ctx.client.openExec('dev', ['wait'], { signal: abort.signal });

  abort.abort();

  const startError = await handle.started.catch((error: unknown) => error);
  const exitError = await handle.exit.catch((error: unknown) => error);
  const rest = await handle.stdout.getReader().read();

  expect(startError).toMatchObject({ name: 'AbortError' });
  expect(exitError).toBe(startError);
  expect(rest.done).toBeTrue();

  const reason = new Error('gave up');
  const custom = new AbortController();

  const second = await ctx.client.openExec('dev', ['wait'], { signal: custom.signal });

  custom.abort(reason);

  const secondError = await second.exit.catch((error: unknown) => error);

  expect(secondError).toBe(reason);
});

test('a stream nobody reads ends the session past maxUnreadBytes', async () => {
  await using ctx = await setupExecTest();

  const handle = await ctx.client.openExec('dev', ['big'], { maxUnreadBytes: 64 * 1024 });
  const rejection = await handle.exit.catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(ExecError);
  expect(rejection).toMatchObject({ code: 'OUTPUT_OVERFLOW' });
});

test('a break out of the output loop and a cancelled stderr stop the command', async () => {
  await using ctx = await setupExecTest();

  const handle = await ctx.client.openExec('dev', ['tick']);

  for await (const chunk of handle.stdout) {
    expect(decoder.decode(chunk)).toBe('tick');
    break;
  }

  await handle.stderr.cancel();

  const rejection = await handle.exit.catch((error: unknown) => error);

  await waitUntil(() => ctx.closed.includes('tick'));

  expect(rejection).toMatchObject({ code: 'CLOSED' });
});

test('started and exit are the same promise on every read, and a late write is CLOSED', async () => {
  await using ctx = await setupExecTest();

  const handle = await ctx.client.openExec('dev', ['fail']);

  expect(handle.exit).toBe(handle.exit);
  expect(handle.started).toBe(handle.started);

  await handle.exit;

  const rejection = await handle.write('late').catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'CLOSED' });
});

test('a refused ticket with a good token is UNAUTHORIZED and names the ticket', async () => {
  await using ctx = await setupExecTest();

  const session = openExecSession({
    baseUrl: ctx.url,
    token: TEST_TOKEN,
    ticket: 'used.ticket',
    start: { name: 'dev', argv: ['cat'], tty: false },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url) => new WebSocket(url),
  });

  const outcome = await session.outcome;

  expect(outcome).toEqual({ kind: 'unauthorized', ticketRefused: true });

  if (outcome.kind === 'unauthorized') {
    expect(toExecError(outcome).message).toContain('exec ticket');
  }
});

// Node's WebSocket fires `error` and no `close` for a refused upgrade
function openSocketWithoutClose(url: string): WebSocket {
  const socket = new WebSocket(url);

  const listen = socket.addEventListener.bind(socket);

  Object.defineProperty(socket, 'addEventListener', {
    value: (type: string, listener: EventListener) => {
      if (type !== 'close') {
        listen(type, listener);
      }
    },
  });

  return socket;
}

test('a refused upgrade reported by an error alone is still UNAUTHORIZED', async () => {
  await using ctx = await setupExecTest();

  const session = openExecSession({
    baseUrl: ctx.url,
    token: 'not-the-token',
    start: { name: 'dev', argv: ['cat'], tty: false },
    onStarted: () => {},
    onOutput: () => {},
    connect: openSocketWithoutClose,
  });

  const outcome = await session.outcome;

  expect(outcome).toEqual({ kind: 'unauthorized' });
});

test('openConsole with a session starts it and reports it', async () => {
  await using ctx = await setupExecTest();

  const handle = await ctx.client.openConsole('dev', { session: 'main', cols: 100, rows: 30 });
  const started = await handle.started;

  handle.close();

  await handle.exit.catch(() => null);

  expect(started).toEqual({
    pid: 42,
    session: 'main',
    created: true,
    groupKill: false,
    output: { continuity: 'none' },
  });

  expect(ctx.requests[0]).toMatchObject({ tty: true, session: 'main', cols: 100, rows: 30 });
});

test('openAttach streams the replay and rejects with DETACHED on a takeover', async () => {
  await using ctx = await setupExecTest();

  const handle = await ctx.client.openAttach('dev', 'main', { cols: 80, rows: 24 });

  const reader = handle.stdout.getReader();

  const first = await reader.read();

  await handle.write('taken');

  const failure = await handle.exit.catch((error: unknown) => error);

  expect(decoder.decode(first.value)).toBe('replay');
  expect(ctx.attaches).toEqual([{ session: 'main', cols: 80, rows: 24 }]);
  expect(failure).toBeInstanceOf(ExecError);
  expect(failure).toMatchObject({ code: 'DETACHED', data: { reason: 'taken_over' } });
});

test('openAttach to no such session fails with the agent code', async () => {
  await using ctx = await setupExecTest();

  const handle = await ctx.client.openAttach('dev', 'gone');
  const failure = await handle.exit.catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(NoSessionError);
  expect(failure).toMatchObject({ code: 'NO_SESSION', data: undefined });
});

test('openAttach with resumeFrom gets its place in the output and the offset at the exit', async () => {
  await using ctx = await setupExecTest();

  const resumeFrom = { executionGeneration: GENERATION, offset: 95 };

  const handle = await ctx.client.openAttach('dev', 'counted', { resumeFrom });
  const started = await handle.started;

  const tail = await new Response(handle.stdout).text();

  const exit = await handle.exit;

  expect(ctx.attaches).toEqual([{ session: 'counted', resumeFrom }]);
  expect(started.output).toEqual(COUNTED_OUTPUT);
  expect(tail).toBe('tail!');
  expect(exit).toEqual({ code: 0, signal: null, offset: 100 });
});

test('NO_SESSION, INVALID_STATE and INVALID_RESUME reject as typed errors with their data', async () => {
  await using ctx = await setupExecTest();

  const ended = await ctx.client.openAttach('dev', 'ended');
  const noSession = await ended.exit.catch((error: unknown) => error);
  const asleep = await ctx.client.openAttach('dev', 'main', { wake: false });
  const invalidState = await asleep.exit.catch((error: unknown) => error);

  const resumeFrom = { executionGeneration: GENERATION, offset: 101 };

  const past = await ctx.client.openAttach('dev', 'main', { resumeFrom });
  const invalidResume = await past.exit.catch((error: unknown) => error);

  expect(noSession).toBeInstanceOf(NoSessionError);

  expect(noSession).toMatchObject({
    data: {
      bootId: 'boot-2',
      coldBoots: [COLD_BOOT],
      previous: { executionGeneration: GENERATION, end: 100, exitCode: 0 },
    },
  });

  expect(invalidState).toBeInstanceOf(InvalidStateError);

  expect(invalidState).toMatchObject({
    data: { state: 'sleeping', allowed: ['running'], coldBoots: [COLD_BOOT] },
  });

  expect(invalidResume).toBeInstanceOf(InvalidResumeError);
  expect(invalidResume).toMatchObject({ data: { end: 100, bufferStart: 0 } });
});

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }

    await Bun.sleep(5);
  }
}

test('a kill grace reaches the agent, and started says whether it kills the group', async () => {
  await using ctx = await setupExecTest();

  for (const [command, groupKill] of [
    ['wait', true],
    ['old', false],
  ] as const) {
    const handle = await ctx.client.openExec('dev', [command], { killGraceMs: 2000 });
    const started = await handle.started;

    handle.close();

    await handle.exit.catch(() => null);

    expect(started.groupKill).toBe(groupKill);
  }

  expect(ctx.requests.map((request) => request.killGraceMs)).toEqual([2000, 2000]);

  const plain = await ctx.client.openExec('dev', ['wait']);
  const plainStarted = await plain.started;

  expect(plainStarted.groupKill).toBe(false);

  plain.close();

  await plain.exit.catch(() => null);
});

// an impd from before offsets sends no output: the client reads it as none
test('a started without output, from an older impd, reads as continuity none', async () => {
  using server = Bun.serve({
    port: 0,
    fetch: (request, bunServer) =>
      bunServer.upgrade(request) ? undefined : new Response('no', { status: 400 }),
    websocket: {
      message: (ws) => {
        ws.send(JSON.stringify({ type: 'started', pid: 5, session: 'main', created: false }));
        ws.send(JSON.stringify({ type: 'exit', code: 0, signal: null }));
      },
    },
  });

  const started: unknown[] = [];

  const session = openExecSession({
    baseUrl: `http://127.0.0.1:${String(server.port)}`,
    token: null,
    start: { name: 'dev', session: 'main' },
    onStarted: (info) => {
      started.push(info);
    },
    onOutput: () => {},
    connect: (url) => new WebSocket(url),
  });

  const outcome = await session.outcome;

  expect(started).toEqual([
    { pid: 5, session: 'main', created: false, groupKill: false, output: { continuity: 'none' } },
  ]);

  expect(outcome).toEqual({ kind: 'exit', code: 0, signal: null });
});

test('a start that requires the broker passes it to impd', async () => {
  await using ctx = await setupExecTest();

  const handle = await ctx.client.openExec('dev', ['fail'], { require: ['broker'] });

  await handle.exit;

  expect(ctx.requests.map((request) => request.require)).toEqual([['broker']]);
});

// impd answers system.info as an older one would: execRequire is not true;
// `calls` holds the path of each request
function buildOlderFetch() {
  const calls: string[] = [];

  const readAsOlder = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;

    calls.push(path);

    const response = await fetch(request);

    if (path !== '/rpc/system/info') {
      return response;
    }

    const text = await response.text();

    return new Response(text.replace('"execRequire":true', '"execRequire":false'), response);
  };

  return { calls, fetch: readAsOlder };
}

test('an impd without execRequire gets no start that requires anything', async () => {
  await using ctx = await setupExecTest();

  const older = buildOlderFetch();
  const client = createImpClient({ url: ctx.url, token: TEST_TOKEN, fetch: older.fetch });

  const handle = await client.openExec('dev', ['tick'], { require: ['broker'] });
  const refused = await handle.exit.catch((error: unknown) => error);

  expect(refused).toBeInstanceOf(ExecError);

  expect(refused).toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: { reason: 'impd_outdated' },
  });

  expect(older.calls).toContain('/rpc/system/info');
  expect(ctx.requests).toEqual([]);
});

test('a session opened directly asks impd before it sends a start that requires anything', async () => {
  await using ctx = await setupExecTest();

  const older = buildOlderFetch();

  const session = openExecSession({
    baseUrl: ctx.url,
    token: TEST_TOKEN,
    start: { name: 'dev', argv: ['tick'], tty: false, require: ['broker'] },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url, headers) => new WebSocket(url, { headers }),
    fetch: older.fetch,
  });

  const outcome = await session.outcome;

  expect(outcome).toMatchObject({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    data: { reason: 'impd_outdated' },
  });

  expect(older.calls).toEqual(['/rpc/system/info']);
  expect(ctx.requests).toEqual([]);
});

test('a resize while a start that requires anything waits on impd goes after the start', async () => {
  await using ctx = await setupExecTest();

  const held: { session: ReturnType<typeof openExecSession> | null } = { session: null };

  // the resize lands after the socket opened, while the feature check runs
  const readResizing = (request: Request): Promise<Response> => {
    held.session?.resize(100, 40);

    return fetch(request);
  };

  held.session = openExecSession({
    baseUrl: ctx.url,
    token: TEST_TOKEN,
    start: { name: 'dev', argv: ['fail'], tty: false, require: ['broker'] },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url, headers) => new WebSocket(url, { headers }),
    fetch: readResizing,
  });

  const outcome = await held.session.outcome;

  expect(outcome).toMatchObject({ kind: 'exit', code: 3 });
  expect(ctx.requests.map((request) => request.require)).toEqual([['broker']]);
});

test('stdin held while a start that requires anything waits on impd counts toward backpressure', async () => {
  await using ctx = await setupExecTest();

  const held: { session: ReturnType<typeof openExecSession> | null } = { session: null };

  const seen: { accepted: boolean | null; drainedEarly: boolean | null } = {
    accepted: null,
    drainedEarly: null,
  };

  // more than the high-water mark lands while the feature check runs
  const readFlooding = async (request: Request): Promise<Response> => {
    const session = held.session;

    if (session !== null) {
      seen.accepted = session.sendStdin(new Uint8Array(1_048_577));

      seen.drainedEarly = await Promise.race([
        session.waitForDrain().then(() => true),
        new Promise<boolean>((resolve) => {
          setTimeout(() => {
            resolve(false);
          }, 50);
        }),
      ]);
    }

    return fetch(request);
  };

  held.session = openExecSession({
    baseUrl: ctx.url,
    token: TEST_TOKEN,
    start: { name: 'dev', argv: ['fail'], tty: false, require: ['broker'] },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url, headers) => new WebSocket(url, { headers }),
    fetch: readFlooding,
  });

  const outcome = await held.session.outcome;

  expect(seen).toEqual({ accepted: false, drainedEarly: false });
  expect(outcome).toMatchObject({ kind: 'exit', code: 3 });
});
