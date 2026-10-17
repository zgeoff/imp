import { MCP_PATH } from '@impz/api';
import type { HttpTransport } from '@impz/mcp';
import type { McpAuth } from './create-mcp-auth';
import type { PublicMcpConfig } from './public-mcp-config';
import { readBodyText } from './read-body-text';

// The public MCP route's listener (docs/guides/mcp.md#public-route): plain
// HTTP behind the operator's TLS front. It reads no client address or
// forwarded header, and logs nothing a request carries.

// requests open at once
const MAX_OPEN = 64;

// with every slot taken, requests that start no work, at once: a session's
// DELETE, or a notification such as notifications/cancelled
const MAX_CONTROL = 16;

// such a notification; a cancel is a few hundred bytes
const MAX_CONTROL_BYTES = 16 * 1024;

// a JSON-RPC message, a file write's content included (4 MiB as text)
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// seconds a request may sit idle; /mcp has none, as a tool call can run for
// minutes
const IDLE_TIMEOUT_S = 30;
const NOT_FOUND = 'not found';

export interface PublicListenerDeps {
  readonly config: PublicMcpConfig;
  readonly oauth: McpAuth;
  readonly mcp: HttpTransport;
}

export interface PublicListener {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

// the routes, apart from the server, for tests to call
export function createPublicHandler(
  deps: Readonly<PublicListenerDeps>,
): (request: Request, server: Pick<Bun.Server<undefined>, 'timeout'> | null) => Promise<Response> {
  const state = { open: 0, control: 0 };
  const host = deps.config.host.toLowerCase();

  const handleRequest = async (
    request: Request,
    server: Pick<Bun.Server<undefined>, 'timeout'> | null,
  ): Promise<Response> => {
    const url = new URL(request.url);

    // a name the front did not route here, or a page that rebinds DNS
    if ((request.headers.get('host') ?? '').toLowerCase() !== host) {
      return buildNotFound();
    }

    const path = url.pathname;

    if (path === MCP_PATH) {
      server?.timeout(request, 0);

      return deps.mcp.handle(request);
    }

    const answered = await deps.oauth.handle(request);

    return answered ?? buildNotFound();
  };

  // Every slot taken: only a request that starts no work gets through, on
  // its own allowance, so a cancel can still stop a call and free a slot.
  // It keeps the idle timeout: it is short, and made again here.
  const handleControl = async (request: Request): Promise<Response> => {
    if (state.control >= MAX_CONTROL) {
      return buildTooMany();
    }

    // counted before its body is read, so no more than MAX_CONTROL bodies
    // are read at once
    state.control += 1;

    try {
      const control = await readControlRequest(request);

      return control === null ? buildTooMany() : await handleRequest(control, null);
    } finally {
      state.control -= 1;
    }
  };

  return async (request, server) => {
    if (state.open >= MAX_OPEN) {
      return handleControl(request);
    }

    state.open += 1;

    const release = createRelease(() => {
      state.open -= 1;
    });

    try {
      const response = await handleRequest(request, server);

      return holdUntilDone(request, response, deps.mcp.readCallEnd(response), release);
    } catch (error) {
      release();
      throw error;
    }
  };
}

// `release`, made safe to call more than once
function createRelease(release: () => void): () => void {
  const state = { isReleased: false };

  return () => {
    if (!state.isReleased) {
      state.isReleased = true;

      release();
    }
  };
}

// A request counts until it is done. A tool call is done when the tool
// ends: as MCP says, a dropped stream is no cancel, so the call runs on and
// keeps its room. Any other response is done once sent, or the client goes.
async function waitThenRelease(callEnd: Promise<void>, release: () => void): Promise<void> {
  try {
    await callEnd;
  } finally {
    release();
  }
}

function holdUntilDone(
  request: Request,
  response: Response,
  callEnd: Promise<void> | null,
  release: () => void,
): Response {
  if (callEnd !== null) {
    void waitThenRelease(callEnd, release);
  } else if (response.body === null) {
    release();

    return response;
  } else {
    request.signal.addEventListener('abort', release, { once: true });
  }

  if (response.body === null) {
    return response;
  }

  const source: ReadableStream<Uint8Array> = response.body;
  const reader = source.getReader();
  const releaseSent = callEnd === null ? release : () => {};

  const held = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const read = await reader.read();

        if (read.done) {
          releaseSent();

          controller.close();

          return;
        }

        controller.enqueue(read.value);
      } catch (error) {
        releaseSent();

        controller.error(error);
      }
    },
    cancel: async (reason) => {
      releaseSent();

      await reader.cancel(reason);
    },
  });

  return new Response(held, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function startPublicListener(
  deps: Readonly<PublicListenerDeps>,
  log: (message: string) => void,
): PublicListener {
  const handle = createPublicHandler(deps);

  const server = Bun.serve({
    port: deps.config.port,
    maxRequestBodySize: MAX_BODY_BYTES,
    idleTimeout: IDLE_TIMEOUT_S,
    fetch: (request, bunServer) => handle(request, bunServer),

    // the reason stays in impd's log; the client gets none
    error: (error) => {
      log(`impd: public mcp: ${error.message}`);

      return new Response('internal error', { status: 500 });
    },
  });

  log(`impd: public mcp on :${String(deps.config.port)} for ${deps.config.origin}`);

  return {
    port: server.port ?? deps.config.port,
    stop: async () => {
      await deps.mcp.close();
      await server.stop(true);
    },
  };
}

// A request to /mcp that starts no work: a DELETE, or a POST of one
// JSON-RPC notification (a method and no id). Its body is read here, so the
// request is made again for the transport; null for any other.
async function readControlRequest(request: Request): Promise<Request | null> {
  if (new URL(request.url).pathname !== MCP_PATH) {
    return null;
  }

  if (request.method === 'DELETE') {
    return request;
  }

  if (request.method !== 'POST') {
    return null;
  }

  const text = await readBodyText(request, MAX_CONTROL_BYTES);

  if (text === null || !isNotification(text)) {
    return null;
  }

  return new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: text,
    signal: request.signal,
  });
}

function isNotification(text: string): boolean {
  let message: unknown;

  try {
    message = JSON.parse(text);
  } catch {
    return false;
  }

  return (
    typeof message === 'object' &&
    message !== null &&
    !Array.isArray(message) &&
    !('id' in message) &&
    'method' in message &&
    typeof message.method === 'string'
  );
}

function buildTooMany(): Response {
  return new Response('too many requests', { status: 429, headers: { 'retry-after': '1' } });
}

function buildNotFound(): Response {
  return new Response(NOT_FOUND, { status: 404 });
}
