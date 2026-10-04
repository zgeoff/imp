import type { Scope } from '@imp/api';
import { createImpGuard, createMcpServer } from '@imp/mcp';
import type { GuardOptions } from '@imp/mcp';
import { createImpClient } from '@zgeoff/imp-client';
import * as z from 'zod';
import type { AgentExecRequest, ExecEvent, ExecStream } from '../agent-client/exec-stream';
import type { AppDeps } from '../build-app';
import { TEST_TOKEN, buildTestApp, setupImpTest } from '../imps/test-imps';

const SIGKILL = 9;
const SIGTERM = 15;

// A guest for the fake VMs, by argv: `head -c N PATH` reads from `files`, the
// write script stores its stdin there, `/bin/sh -c` runs buildShellStream's
// scripts, and `signals` holds each signal a command got as `command:number`.
function buildFakeGuest(oldAgent: boolean) {
  const files = new Map<string, Uint8Array>();

  const requests: AgentExecRequest[] = [];
  const signals: string[] = [];

  // the commands whose stream impd closed, as when its client went away
  const closed: string[] = [];

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

    const stream = buildShellStream(command, (signal) => {
      signals.push(`${command}:${String(signal)}`);
    });

    return Promise.resolve({
      ...stream,
      groupKill: !oldAgent && request.killGraceMs !== undefined,
      close: () => {
        closed.push(command);
      },
    });
  };

  return { files, requests, signals, closed, openExec };
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

// `echo TEXT`, `kill …` (exits 0), `fail` (stderr and exit 3), `flood N` (N
// bytes from HEAD to TAIL), `cat` (echoes stdin), `sleepy` (runs until
// SIGTERM) and `stubborn` (ignores SIGTERM, as a trap or a nohup'd child does)
function buildShellStream(command: string, recordSignal: (signal: number) => void) {
  const stream = buildEventStream();
  const [verb = '', ...rest] = command.split(' ');

  if (verb === 'echo') {
    stream.emitText('stdout', `${rest.join(' ')}\n`);
    stream.emit({ type: 'exit', code: 0, signal: 0 });
  }

  // a command that runs for N ms, longer than any idle timeout on the way
  if (verb === 'wait') {
    setTimeout(() => {
      stream.emitText('stdout', 'waited\n');
      stream.emit({ type: 'exit', code: 0, signal: 0 });
    }, Number(rest[0]));
  }

  // the sweep that kills what is left of a stopped command's group
  if (verb === 'kill') {
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
      session: null,
      created: true,
      groupKill: false,
      output: null,
      writeStdin: hooks.writeStdin ?? (() => {}),
      stdinDrained: () => Promise.resolve(),
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

const TextContentSchema = z.object({ type: z.literal('text'), text: z.string() });

const ToolResultSchema = z.object({
  content: z.tuple([TextContentSchema]),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

interface ImpdTestOptions {
  readonly tailnet?: AppDeps['tailnet'];

  // the imp's agent predates the group kill (protocol 0.8.0)
  readonly oldAgent?: boolean;

  // the server's token is a manage token for these imps, not the root token
  readonly tokenImps?: readonly string[];

  // impd's environment, such as the public route's
  readonly env?: Readonly<Record<string, string>>;
}

// impd's app on a real port (exec needs a WebSocket) with the fake guest and
// an image, and a client for it
export async function setupImpdTest(options: Readonly<ImpdTestOptions> = {}) {
  const harness = await setupImpTest({ ...(options.env !== undefined && { env: options.env }) });

  const guest = buildFakeGuest(options.oldAgent ?? false);

  // the fake guest runs no agent, but the imp wakes or boots as for a real one
  const built = buildTestApp(
    harness,
    harness,
    TEST_TOKEN,
    {
      openExec: async (name, request) => {
        await harness.imps.requireRunning(name);

        return guest.openExec(name, request);
      },
    },
    options.tailnet ?? null,
  );

  const server = built.app.listen(0);
  const url = `http://127.0.0.1:${String(server.server?.port)}`;
  const client = createImpClient({ url, token: TEST_TOKEN });

  await harness.createTestImage('ubuntu');

  return {
    ...harness,
    guest,
    client,
    rootClient: built.client,
    publicMcp: built.publicMcp,
    peers: built.peers,
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
  readonly scope?: Scope;

  // the imp's agent predates the group kill (protocol 0.8.0)
  readonly oldAgent?: boolean;

  // the server's token is a manage token for these imps, not the root token
  readonly tokenImps?: readonly string[];
}

// an impd as setupImpdTest makes it, and an MCP server in process over its
// client, as stdio runs it; `sent` holds every message it wrote, parsed
export async function setupMcpTest(options: Readonly<McpTestOptions> = {}) {
  const impd = await setupImpdTest({
    ...(options.oldAgent !== undefined && { oldAgent: options.oldAgent }),
  });

  const sent: unknown[] = [];
  const server = createMcpServer({ version: '1.2.3', progressIntervalMs: 50, killGraceMs: 50 });

  const scoped =
    options.tokenImps === undefined
      ? null
      : await impd.client.tokens.create({
          name: 'mcp',
          scope: 'manage',
          imps: [...options.tokenImps],
        });

  const context = {
    reply: (message: string) => {
      sent.push(JSON.parse(message));
    },
    client:
      scoped === null ? impd.client : createImpClient({ url: impd.url, token: scoped.secret }),
    guard: createImpGuard(options.guard ?? { all: true }),
    scope: options.scope ?? 'manage',
  };

  const mcp = {
    receive: (line: string) => server.receive(line, context),
    close: () => server.close(),
  };

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
