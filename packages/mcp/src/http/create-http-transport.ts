import {
  INVALID_REQUEST,
  PARSE_ERROR,
  createMcpHandler,
  isInitializeRequest,
  isJSONRPCRequest,
  isLegacyRequest,
} from '@modelcontextprotocol/server';
import { createCallRegistry } from '../create-call-registry';
import { createCallerAuth, findCallerAuth } from '../create-caller-auth';
import { createImpServer } from '../create-imp-server';
import type { ImpServerOptions } from '../create-imp-server';
import { createLegacySessions } from './create-legacy-sessions';
import type { LegacySession, SessionOwner } from './create-legacy-sessions';

// Who a request comes from, as the host resolved it for this one request:
// the same `key` for every request of one caller, whose sessions answer only
// it, and the `ends` that end them
export type McpPrincipal = SessionOwner;

export interface HttpTransportOptions extends ImpServerOptions {
  // null for a request with no caller: a 401
  readonly authenticate: (request: Request) => Promise<McpPrincipal | null>;

  // true for a browser's request from a page on another origin: a 403,
  // before the request is authenticated
  readonly isCrossOrigin: (request: Request) => boolean;

  // the WWW-Authenticate a 401 carries; `Bearer` when left out
  readonly challenge?: string;

  // between SSE comments, so no idle timeout ends a long call's stream
  readonly keepaliveMs?: number;
  readonly limits?: { readonly perCaller: number; readonly total: number; readonly idleMs: number };
  readonly now?: () => number;
}

export interface HttpTransport {
  readonly handle: (request: Request) => Promise<Response>;

  // ends every session and stops what their calls run
  readonly close: () => Promise<void>;

  // when the tool call behind a streamed response ends, which a dropped
  // stream does not hasten; null for any other response
  readonly readCallEnd: (response: Response) => Promise<void> | null;
}

const SESSION_HEADER = 'mcp-session-id';
const KEEPALIVE_MS = 5000;
const DEFAULT_LIMITS = { perCaller: 16, total: 256, idleMs: 3_600_000 };

// MCP's streamable HTTP transport at one endpoint, on the SDK: a 2026-07-28
// request to its sessionless per-request handler, a 2025-era one to the
// session its `initialize` opened. The rules are in docs/guides/mcp.md#http.
export function createHttpTransport(options: Readonly<HttpTransportOptions>): HttpTransport {
  const now = options.now ?? Date.now;
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
  const challenge = options.challenge ?? 'Bearer';

  // each streamed call's end, by its response
  const callEnds = new WeakMap<Response, Promise<void>>();

  // every tool call in flight, for close
  const running = new Set<Promise<void>>();

  const sessions = createLegacySessions({
    limits: options.limits ?? DEFAULT_LIMITS,
    now,
    keepaliveMs,
    createServer: (owner, calls) => createImpServer(options, owner, calls),
  });

  const modern = createMcpHandler(
    (context) => {
      const auth = findCallerAuth(context.authInfo);

      if (auth === null) {
        throw new Error('an MCP request reached the server without its caller');
      }

      return createImpServer(options, auth.caller, createCallRegistry());
    },
    { legacy: 'reject', keepAliveMs: keepaliveMs },
  );

  // the AuthInfo that carries the caller, and for a tool call the end that
  // readCallEnd reports
  const startExchange = (message: unknown, principal: Readonly<McpPrincipal>) => {
    if (!isJSONRPCRequest(message) || message.method !== 'tools/call') {
      return { authInfo: createCallerAuth(principal), ended: null };
    }

    const ended = Promise.withResolvers<void>();

    running.add(ended.promise);

    void (async () => {
      await ended.promise;

      running.delete(ended.promise);
    })();

    return { authInfo: createCallerAuth(principal, ended.resolve), ended };
  };

  // a call answered on a stream ends when its tool does; one answered any
  // other way has ended, or never ran
  const buildExchangeResponse = (
    response: Response,
    ended: PromiseWithResolvers<void> | null,
  ): Response => {
    if (ended === null) {
      return response;
    }

    if (
      response.body === null ||
      !(response.headers.get('content-type') ?? '').startsWith('text/event-stream')
    ) {
      ended.resolve();

      return response;
    }

    // the SDK closes a call's stream once it has answered, and answers a call
    // its schema refuses without running the tool; a stream the client drops
    // never closes this way
    const tracked = new Response(
      response.body.pipeThrough(new TransformStream({ flush: () => ended.resolve() })),
      { status: response.status, headers: response.headers },
    );

    callEnds.set(tracked, ended.promise);

    return tracked;
  };

  const handleModern = async (
    request: Request,
    body: string,
    message: unknown,
    principal: Readonly<McpPrincipal>,
  ): Promise<Response> => {
    const exchange = startExchange(message, principal);

    // the end of what the caller authenticated with ends its calls, as it
    // ends a session
    const signals = principal.ends === null ? [request.signal] : [request.signal, principal.ends];

    const response = await modern.fetch(
      new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body,
        signal: AbortSignal.any(signals),
      }),
      { authInfo: exchange.authInfo, parsedBody: message },
    );

    return buildExchangeResponse(response, exchange.ended);
  };

  const runInSession = async (
    session: Readonly<LegacySession>,
    request: Request,
    message: unknown,
    principal: Readonly<McpPrincipal>,
  ): Promise<Response> => {
    const exchange = startExchange(message, principal);

    if (exchange.ended !== null && isJSONRPCRequest(message)) {
      const id = message.id;

      sessions.track(session, exchange.ended.promise);

      // a cancelled call gets no answer, which would leave its stream open
      // until the session ends; once the SDK has had its chance to answer,
      // the stream ends
      const ended = exchange.ended.promise;

      void (async () => {
        await ended;
        await waitForMicrotasks();

        session.transport.closeSSEStream(id);
      })();
    }

    const response = await session.transport.handleRequest(request, {
      authInfo: exchange.authInfo,
      parsedBody: message,
    });

    return buildExchangeResponse(response, exchange.ended);
  };

  const handleLegacy = async (
    request: Request,
    message: unknown,
    principal: Readonly<McpPrincipal>,
  ): Promise<Response> => {
    if (isInitializeRequest(message)) {
      const opened = await sessions.open(principal);

      if (opened === null) {
        return buildText(429, 'too many MCP sessions: end one with a DELETE first');
      }

      return runInSession(opened, request, message, principal);
    }

    const found = findSession(request, principal);

    return found instanceof Response ? found : runInSession(found, request, message, principal);
  };

  const handlePost = async (
    request: Request,
    principal: Readonly<McpPrincipal>,
  ): Promise<Response> => {
    if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
      return buildText(415, 'a POST carries one JSON-RPC message as application/json');
    }

    const body = await request.text();

    let message: unknown;

    try {
      message = JSON.parse(body);
    } catch {
      return buildRpcError(400, PARSE_ERROR, 'parse error: not JSON');
    }

    // MCP dropped batches in 2025-06-18
    if (Array.isArray(message)) {
      return buildRpcError(400, INVALID_REQUEST, 'invalid request: send one message per POST');
    }

    const isLegacy = await isLegacyRequest(request, message);

    return isLegacy
      ? handleLegacy(request, message, principal)
      : handleModern(request, body, message, principal);
  };

  // the request's session, or the response that refuses it
  const findSession = (
    request: Request,
    principal: Readonly<McpPrincipal>,
  ): LegacySession | Response => {
    const id = request.headers.get(SESSION_HEADER);

    if (id === null) {
      return buildRpcError(400, -32_000, `no ${SESSION_HEADER}: initialize first`);
    }

    // another caller's session is as unknown as an ended one
    return sessions.findOwned(id, principal.key) ?? buildText(404, 'no such MCP session');
  };

  const handleDelete = async (
    request: Request,
    principal: Readonly<McpPrincipal>,
  ): Promise<Response> => {
    const found = findSession(request, principal);

    if (found instanceof Response) {
      return found;
    }

    await sessions.end(found);

    return new Response(null, { status: 204 });
  };

  return {
    handle: async (request) => {
      if (options.isCrossOrigin(request)) {
        return buildText(403, 'a page on another origin may not call MCP');
      }

      if (request.method !== 'POST' && request.method !== 'DELETE') {
        return buildText(405, 'POST a message, or DELETE a session', { allow: 'POST, DELETE' });
      }

      sessions.sweep();

      const principal = await options.authenticate(request);

      if (principal === null) {
        return buildText(401, 'unauthorized', { 'www-authenticate': challenge });
      }

      return request.method === 'POST'
        ? handlePost(request, principal)
        : handleDelete(request, principal);
    },
    close: async () => {
      await modern.close();
      await sessions.endAll();
      await Promise.all(running);
    },
    readCallEnd: (response) => callEnds.get(response) ?? null,
  };
}

// every microtask queued so far, and the ones they queue, have run
function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function buildRpcError(status: number, code: number, message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', id: null, error: { code, message } },
    { status, headers: { 'content-type': 'application/json' } },
  );
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
