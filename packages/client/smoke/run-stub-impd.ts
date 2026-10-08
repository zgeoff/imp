import type {
  AgentExecRequest,
  ExecEvent,
  ExecStream,
} from '@imp/daemon/src/agent-client/exec-stream';
import { TEST_TOKEN, buildTestApp, createImpTest } from '@imp/daemon/src/imps/test-imps';
import type { Server } from 'bun';

// impd's own app with a fake agent and one imp, `smoke`, for smoke.ts.
// Prints { url, prefixedUrl, closedUrl, token } as one JSON line and serves
// until SIGTERM; prefixedUrl serves impd only under /impd/.
const PREFIX = '/impd';

// what it started, released on SIGTERM and on a setup step that throws
const stack = new AsyncDisposableStack();

const served = await startOrRelease();

process.on('SIGTERM', () => {
  void stopAndExit();
});

console.log(JSON.stringify(served));

async function startOrRelease() {
  try {
    return await startStubImpd();
  } catch (error) {
    await stack.disposeAsync();

    throw error;
  }
}

async function stopAndExit(): Promise<void> {
  await stack.disposeAsync();

  process.exit(0);
}

async function startStubImpd() {
  const harness = await createImpTest(stack);

  const built = buildTestApp(harness, harness, TEST_TOKEN, {
    openExec: (_name, request) => Promise.resolve(buildFakeStream(request)),
  });

  const app = built.app.listen({ hostname: '127.0.0.1', port: 0 });

  stack.defer(async () => {
    await app.stop();
  });

  const url = `http://127.0.0.1:${String(app.server?.port)}`;
  const proxy = startPrefixProxy(url);

  stack.defer(() => proxy.stop(true));

  const closedUrl = await findClosedUrl();

  await harness.createTestImage('ubuntu');
  await built.client.imps.create({ name: 'smoke' });

  return { url, prefixedUrl: `${proxy.url.origin}${PREFIX}/`, closedUrl, token: TEST_TOKEN };
}

// `cat` without a tty echoes stdin until EOF. With a tty, as a console has,
// it reports its size and each resize, echoes what it reads, and ends by
// SIGINT on ^C, as a shell's foreground job would.
function buildFakeStream(request: Readonly<AgentExecRequest>): ExecStream {
  const encoder = new TextEncoder();

  const queue: EventQueue = { events: [], wake: null };

  const emitEvent = (event: ExecEvent): void => {
    queue.events.push(event);
    queue.wake?.();
  };

  const emitText = (text: string): void => {
    emitEvent({ type: 'stdout', data: encoder.encode(text) });
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

  if (request.tty) {
    emitText(`tty ${String(request.cols)}x${String(request.rows)}\n`);
  }

  return {
    pid: 7,
    session: null,
    created: false,
    groupKill: false,
    output: null,
    writeStdin: (data) => {
      const text = new TextDecoder().decode(data);

      if (request.tty && text.includes('\u0003')) {
        emitEvent({ type: 'exit', code: 130, signal: 2 });
      } else {
        emitEvent({ type: 'stdout', data });
      }
    },
    stdinDrained: () => Promise.resolve(),
    closeStdin: () => {
      emitEvent({ type: 'exit', code: 0, signal: 0 });
    },
    resize: (cols, rows) => {
      emitText(`resize ${String(cols)}x${String(rows)}\n`);
    },
    sendSignal: (signal) => {
      emitEvent({ type: 'exit', code: 128 + signal, signal });
    },
    events: () => readEvents(waitForEvent),
    close: () => {},
  };
}

interface EventQueue {
  readonly events: ExecEvent[];
  wake: (() => void) | null;
}

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

interface ProxySocket {
  readonly upstreamUrl: string;
  upstream: WebSocket | null;

  // what the client sends before the upstream opens waits for it
  readonly pending: (string | Uint8Array)[];
}

// A reverse proxy that strips /impd, as one in front of a real impd would,
// for HTTP and for the exec WebSocket. Anything outside the prefix is a 404.
function startPrefixProxy(upstreamBase: string): Server<ProxySocket> {
  return Bun.serve<ProxySocket>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) => {
      const incoming = new URL(request.url);

      if (!incoming.pathname.startsWith(`${PREFIX}/`)) {
        return new Response('not under the prefix', { status: 404 });
      }

      const target = new URL(
        `${incoming.pathname.slice(PREFIX.length)}${incoming.search}`,
        upstreamBase,
      );

      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return fetch(new Request(target.href, request));
      }

      target.protocol = 'ws:';

      const data: ProxySocket = { upstreamUrl: target.href, upstream: null, pending: [] };

      return server.upgrade(request, { data })
        ? undefined
        : new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open: (socket) => {
        const upstream = new WebSocket(socket.data.upstreamUrl);

        upstream.binaryType = 'arraybuffer';
        socket.data.upstream = upstream;

        upstream.addEventListener('open', () => {
          for (const data of socket.data.pending.splice(0)) {
            upstream.send(data);
          }
        });

        upstream.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
          const data = typeof event.data === 'string' ? event.data : new Uint8Array(event.data);

          socket.send(data);
        });

        upstream.addEventListener('close', (event) => {
          stopSocket(socket, event.code, event.reason);
        });
      },
      message: (socket, message) => {
        const data = typeof message === 'string' ? message : new Uint8Array(message);

        if (socket.data.upstream?.readyState === WebSocket.OPEN) {
          socket.data.upstream.send(data);
        } else {
          socket.data.pending.push(data);
        }
      },
      close: (socket, code, reason) => {
        stopSocket(socket.data.upstream, code, reason);
      },
    },
  });
}

// 1005 and 1006 report a close with no frame; neither may be sent
function stopSocket(socket: Pick<WebSocket, 'close'> | null, code: number, reason: string): void {
  if (code === 1005 || code === 1006) {
    socket?.close();
  } else {
    socket?.close(code, reason);
  }
}

async function findClosedUrl(): Promise<string> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const closed = `http://127.0.0.1:${String(server.port)}`;

  await server.stop(true);

  return closed;
}
