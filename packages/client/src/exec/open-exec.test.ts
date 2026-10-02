import { expect, test } from 'bun:test';
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
import { ExecError, toExecError } from './exec-error';
import { CONSOLE_SHELL } from './open-exec';
import { openExecSession } from './open-exec-session';

const BIG_BYTES = 512 * 1024;

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

  abort.abort();

  const closedExit = await closed.exit.catch((error: unknown) => error);
  const abortedExit = await aborted.exit.catch((error: unknown) => error);
  const rest = await closed.stdout.getReader().read();

  expect(closedExit).toMatchObject({ code: 'CLOSED' });
  expect(abortedExit).toMatchObject({ code: 'CLOSED' });
  expect(rest.done).toBeTrue();
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

test('openConsole with a session starts it and reports it', async () => {
  await using ctx = await setupExecTest();

  const handle = await ctx.client.openConsole('dev', { session: 'main', cols: 100, rows: 30 });
  const started = await handle.started;

  handle.close();

  await handle.exit.catch(() => null);

  expect(started).toEqual({ pid: 42, session: 'main', created: true });
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

  expect(failure).toMatchObject({ code: 'NO_SESSION' });
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
