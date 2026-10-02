import type {
  AgentExecRequest,
  ExecEvent,
  ExecStream,
} from '@imp/daemon/src/agent-client/exec-stream';
import { TEST_TOKEN, buildTestApp, setupImpTest } from '@imp/daemon/src/imps/test-imps';
import { createImpClient } from '@zgeoff/imp-client';
import * as z from 'zod';
import { createImpGuard } from './imp-guard';
import type { GuardOptions } from './imp-guard';
import { createMcpServer } from './mcp-server';

const SIGKILL = 9;
const SIGTERM = 15;

// A guest for the fake VMs, by argv: `head -c N PATH` reads from `files`, the
// write script stores its stdin there, `/bin/sh -c` runs buildShellStream's
// scripts, and `signals` holds each signal a command got as `command:number`.
function buildFakeGuest() {
  const files = new Map<string, Uint8Array>();

  const requests: AgentExecRequest[] = [];
  const signals: string[] = [];

  const openExec = (_name: string, request: Readonly<AgentExecRequest>): Promise<ExecStream> => {
    requests.push(request);

    const [program = '', flag = '', script = '', readPath = '', writePath = ''] = request.argv;

    if (program === 'head' && flag === '-c') {
      return Promise.resolve(buildReadStream(files, Number(script), readPath));
    }

    if (program === '/bin/sh' && request.argv.length === 5) {
      return Promise.resolve(
        buildWriteStream(writePath, (data) => {
          files.set(writePath, data);
        }),
      );
    }

    const command = program === '/bin/sh' ? script : request.argv.join(' ');

    return Promise.resolve(
      buildShellStream(command, (signal) => {
        signals.push(`${command}:${String(signal)}`);
      }),
    );
  };

  return { files, requests, signals, openExec };
}

function buildReadStream(files: ReadonlyMap<string, Uint8Array>, count: number, path: string) {
  const stream = buildEventStream();
  const content = files.get(path);

  if (content === undefined) {
    stream.emitText(
      'stderr',
      `head: cannot open '${path}' for reading: No such file or directory\n`,
    );

    stream.emit({ type: 'exit', code: 1, signal: 0 });
  } else {
    stream.emit({ type: 'stdout', data: content.subarray(0, count) });
    stream.emit({ type: 'exit', code: 0, signal: 0 });
  }

  return stream.toExecStream();
}

// /readonly/... fails, as a read-only file system would
function buildWriteStream(path: string, store: (data: Uint8Array) => void) {
  const stream = buildEventStream();
  const chunks: Uint8Array[] = [];

  return stream.toExecStream({
    writeStdin: (data) => {
      chunks.push(data);
    },
    closeStdin: () => {
      if (path.startsWith('/readonly/')) {
        stream.emitText(
          'stderr',
          `mkdir: can't create directory '/readonly': Read-only file system\n`,
        );

        stream.emit({ type: 'exit', code: 1, signal: 0 });

        return;
      }

      store(new Uint8Array(Buffer.concat(chunks)));

      stream.emit({ type: 'exit', code: 0, signal: 0 });
    },
  });
}

// `echo TEXT`, `fail` (stderr and exit 3), `flood N` (N bytes that start
// with HEAD and end with TAIL), `cat` (echoes stdin), `sleepy` (runs until
// SIGTERM) and `stubborn` (ignores SIGTERM, as a trap or nohup'd child would)
function buildShellStream(command: string, recordSignal: (signal: number) => void) {
  const stream = buildEventStream();
  const [verb = '', ...rest] = command.split(' ');

  if (verb === 'echo') {
    stream.emitText('stdout', `${rest.join(' ')}\n`);
    stream.emit({ type: 'exit', code: 0, signal: 0 });
  }

  if (verb === 'fail') {
    stream.emitText('stdout', 'partial');
    stream.emitText('stderr', 'boom');
    stream.emit({ type: 'exit', code: 3, signal: 0 });
  }

  if (verb === 'flood') {
    const size = Number(rest[0]);

    const body = new Uint8Array(size).fill(120);

    body.set(new TextEncoder().encode('HEAD'), 0);
    body.set(new TextEncoder().encode('TAIL'), size - 4);

    for (let offset = 0; offset < size; offset += 4096) {
      stream.emit({ type: 'stdout', data: body.subarray(offset, offset + 4096) });
    }

    stream.emit({ type: 'exit', code: 0, signal: 0 });
  }

  return stream.toExecStream({
    writeStdin: (data) => {
      if (verb === 'cat') {
        stream.emit({ type: 'stdout', data });
      }
    },
    closeStdin: () => {
      if (verb === 'cat') {
        stream.emit({ type: 'exit', code: 0, signal: 0 });
      }
    },
    sendSignal: (signal) => {
      recordSignal(signal);

      const ignored = verb === 'stubborn' && signal === SIGTERM;

      if (!ignored && (signal === SIGTERM || signal === SIGKILL)) {
        stream.emit({ type: 'exit', code: 128 + signal, signal });
      }
    },
  });
}

type StreamHooks = Partial<Pick<ExecStream, 'writeStdin' | 'closeStdin' | 'sendSignal'>>;

interface EventQueue {
  readonly events: ExecEvent[];
  wake: (() => void) | null;
}

// the events in order, up to and including the exit
async function* readEvents(
  next: () => Promise<ExecEvent>,
): AsyncGenerator<ExecEvent, void, undefined> {
  for (;;) {
    const event = await next();

    yield event;

    if (event.type === 'exit') {
      return;
    }
  }
}

function buildEventStream() {
  const queue: EventQueue = { events: [], wake: null };

  const emit = (event: ExecEvent): void => {
    queue.events.push(event);
    queue.wake?.();
  };

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
    emit,
    emitText: (type: 'stdout' | 'stderr', text: string) => {
      emit({ type, data: new TextEncoder().encode(text) });
    },
    toExecStream: (hooks: Readonly<StreamHooks> = {}): ExecStream => ({
      pid: 42,
      writeStdin: hooks.writeStdin ?? (() => {}),
      closeStdin: hooks.closeStdin ?? (() => {}),
      resize: () => {},
      sendSignal: hooks.sendSignal ?? (() => {}),
      events: () => readEvents(waitForEvent),
      close: () => {},
    }),
  };
}

// a JSON-RPC response as the tests read it
const ResponseSchema = z.object({
  id: z.union([z.string(), z.number()]).nullable(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

export type Response = z.infer<typeof ResponseSchema>;

const TextContentSchema = z.object({ type: z.literal('text'), text: z.string() });

const ToolResultSchema = z.object({
  content: z.tuple([TextContentSchema]),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

// impd's app on a real port (exec needs a WebSocket) with the fake guest and
// an image, and a client for it
export async function setupImpdTest() {
  const harness = await setupImpTest();

  const guest = buildFakeGuest();

  // the fake guest runs no agent, but the imp wakes or boots as for a real one
  const built = buildTestApp(harness, harness, TEST_TOKEN, async (name, request) => {
    await harness.imps.requireRunning(name);

    return guest.openExec(name, request);
  });

  const server = built.app.listen(0);
  const url = `http://127.0.0.1:${String(server.server?.port)}`;
  const client = createImpClient({ url, token: TEST_TOKEN });

  await harness.createTestImage('ubuntu');

  return {
    ...harness,
    guest,
    client,
    url,
    token: TEST_TOKEN,
    async [Symbol.asyncDispose]() {
      await server.stop(true);
      await harness[Symbol.asyncDispose]();
    },
  };
}

interface McpTestOptions {
  readonly guard?: GuardOptions;
}

// an impd as setupImpdTest makes it, and an MCP server in process over its
// client; `sent` holds every message the server wrote, parsed
export async function setupMcpTest(options: Readonly<McpTestOptions> = {}) {
  const impd = await setupImpdTest();

  const sent: unknown[] = [];

  const mcp = createMcpServer({
    client: impd.client,
    guard: createImpGuard(options.guard ?? { all: true }),
    version: '1.2.3',
    send: (message) => {
      sent.push(JSON.parse(message));
    },
    progressIntervalMs: 50,
    killGraceMs: 50,
  });

  let nextId = 1;

  // sends one request and returns its response, or undefined when the
  // server sent none
  const sendRequest = async (method: string, params: unknown = {}, id: number = nextId++) => {
    await mcp.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

    const found = sent
      .map((message) => ResponseSchema.safeParse(message))
      .find((parsed) => parsed.success && parsed.data.id === id);

    return found?.data;
  };

  const runTool = async (name: string, args: unknown = {}): Promise<ToolResult> => {
    const response = await sendRequest('tools/call', { name, arguments: args });

    return ToolResultSchema.parse(response?.result);
  };

  return { ...impd, mcp, sent, sendRequest, runTool };
}
