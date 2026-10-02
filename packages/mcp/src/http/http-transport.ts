import type { Scope } from '@imp/api';
import type { ImpGuard } from '../imp-guard';
import { formatError, parseMessage } from '../json-rpc';
import { PROTOCOL_VERSIONS, createMcpServer } from '../mcp-server';
import type { McpServer, McpServerOptions, MessageContext } from '../mcp-server';
import type { ToolClient } from '../tools/tool-client';
import { createSessionStore } from './session-store';
import type { McpSession } from './session-store';

// Who a request comes from, as the host resolved it for this one request
export interface McpPrincipal {
  // the same for every request of one caller: a session answers only it
  readonly key: string;
  readonly scope: Scope;
  readonly client: ToolClient;
  readonly guard: ImpGuard;

  // aborts when what the caller authenticated with ends; its sessions end
  readonly ends: AbortSignal | null;
}

export interface HttpTransportOptions extends McpServerOptions {
  // null for a request with no caller: a 401
  readonly authenticate: (request: Request) => Promise<McpPrincipal | null>;

  // true for a browser's request from a page on another origin: a 403,
  // before the request is authenticated
  readonly isCrossOrigin: (request: Request) => boolean;

  // between SSE comments, so no idle timeout ends a long call's stream
  readonly keepaliveMs?: number;
  readonly limits?: { readonly perCaller: number; readonly total: number; readonly idleMs: number };
  readonly now?: () => number;
}

export interface HttpTransport {
  readonly handle: (request: Request) => Promise<Response>;

  // ends every session and stops what their calls run
  readonly close: () => Promise<void>;
}

const SESSION_HEADER = 'mcp-session-id';
const VERSION_HEADER = 'mcp-protocol-version';
const KEEPALIVE_MS = 5000;
const DEFAULT_LIMITS = { perCaller: 16, total: 256, idleMs: 3_600_000 };

// MCP's streamable HTTP transport at one endpoint: one message per POST, in
// a session that `initialize` opens. No GET stream and no resume; the rules
// are in docs/guides/mcp.md#http.
export function createHttpTransport(options: Readonly<HttpTransportOptions>): HttpTransport {
  const now = options.now ?? Date.now;
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;

  const sessions = createSessionStore({
    limits: options.limits ?? DEFAULT_LIMITS,
    now,
    createServer: (): McpServer => createMcpServer(options),
  });

  const handlePost = async (request: Request): Promise<Response> => {
    const principal = await options.authenticate(request);

    if (principal === null) {
      return buildText(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
    }

    if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
      return buildText(415, 'a POST carries one JSON-RPC message as application/json');
    }

    const body = await request.text();

    const message = parseMessage(body);

    if (message.kind === 'invalid') {
      return buildJson(400, formatError(null, message.code, message.message));
    }

    if (message.kind === 'request' && message.method === 'initialize') {
      const opened = sessions.open(principal);

      if (opened === null) {
        return buildText(429, 'too many MCP sessions: end one with a DELETE first');
      }

      return runJsonCall(opened, body, principal, { [SESSION_HEADER]: opened.id });
    }

    const found = findSession(request, principal);

    if (found instanceof Response) {
      return found;
    }

    if (message.kind !== 'request') {
      await found.server.receive(
        body,
        buildContext(principal, () => {}),
      );

      return new Response(null, { status: 202 });
    }

    const streams = (request.headers.get('accept') ?? '').includes('text/event-stream');

    return streams && message.method === 'tools/call'
      ? runStreamCall(found, body, principal)
      : runJsonCall(found, body, principal);
  };

  // the request's session, or the response that refuses it
  const findSession = (request: Request, principal: Readonly<McpPrincipal>) => {
    const id = request.headers.get(SESSION_HEADER);
    const version = request.headers.get(VERSION_HEADER);
    const supported: readonly string[] = PROTOCOL_VERSIONS;

    if (id === null) {
      return buildJson(400, formatError(null, -32_000, `no ${SESSION_HEADER}: initialize first`));
    }

    if (version !== null && !supported.includes(version)) {
      return buildText(400, `unsupported ${VERSION_HEADER}: ${version}`);
    }

    // another caller's session is as unknown as an ended one
    return sessions.get(id, principal.key) ?? buildText(404, 'no such MCP session');
  };

  // the call's response as JSON once it is done; progress is dropped
  const runJsonCall = async (
    session: Readonly<McpSession>,
    body: string,
    principal: Readonly<McpPrincipal>,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Response> => {
    let response: string | null = null;

    await sessions.track(session, () =>
      session.server.receive(
        body,
        buildContext(principal, (message) => {
          if (isResponse(message)) {
            response = message;
          }
        }),
      ),
    );

    // a cancelled request has no response
    return response === null
      ? new Response(null, { status: 202, headers })
      : buildJson(200, response, headers);
  };

  // the call's progress and response as server-sent events
  const runStreamCall = (
    session: Readonly<McpSession>,
    body: string,
    principal: Readonly<McpPrincipal>,
  ): Response => {
    const encoder = new TextEncoder();

    const state = { open: true };

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = (text: string): void => {
          if (state.open) {
            controller.enqueue(encoder.encode(text));
          }
        };

        const keepalive = setInterval(() => {
          write(': keepalive\n\n');
        }, keepaliveMs);

        const context = buildContext(principal, (message) => {
          write(`event: message\ndata: ${message}\n\n`);
        });

        void (async () => {
          try {
            await sessions.track(session, () => session.server.receive(body, context));
          } finally {
            clearInterval(keepalive);

            if (state.open) {
              state.open = false;

              controller.close();
            }
          }
        })();
      },

      // a dropped stream is no cancel: the call runs on, its answer lost
      cancel: () => {
        state.open = false;
      },
    });

    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  };

  const handleDelete = async (request: Request): Promise<Response> => {
    const principal = await options.authenticate(request);

    if (principal === null) {
      return buildText(401, 'unauthorized', { 'www-authenticate': 'Bearer' });
    }

    const found = findSession(request, principal);

    if (found instanceof Response) {
      return found;
    }

    await sessions.end(found);

    return new Response(null, { status: 204 });
  };

  return {
    handle: (request) => {
      if (options.isCrossOrigin(request)) {
        return Promise.resolve(buildText(403, 'a page on another origin may not call MCP'));
      }

      sessions.sweep();

      if (request.method === 'POST') {
        return handlePost(request);
      }

      if (request.method === 'DELETE') {
        return handleDelete(request);
      }

      return Promise.resolve(
        buildText(405, 'POST a message, or DELETE a session', { allow: 'POST, DELETE' }),
      );
    },
    close: () => sessions.endAll(),
  };
}

function buildContext(
  principal: Readonly<McpPrincipal>,
  reply: MessageContext['reply'],
): MessageContext {
  return { reply, client: principal.client, guard: principal.guard, scope: principal.scope };
}

// a response carries an id and no method; a progress notification the reverse
function isResponse(message: string): boolean {
  return parseMessage(message).kind === 'response';
}

function buildJson(
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function buildText(
  status: number,
  text: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(`${text}\n`, {
    status,
    headers: { 'content-type': 'text/plain', ...headers },
  });
}
