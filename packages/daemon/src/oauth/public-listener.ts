import type { HttpTransport } from '@imp/mcp';
import { MCP_PATH } from '../mcp/mcp-endpoint';
import {
  AUTHORIZATION_SERVER_PATH,
  AUTHORIZE_PATH,
  PROTECTED_RESOURCE_PATH,
  REVOKE_PATH,
  TOKEN_PATH,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from './oauth-metadata';
import { buildPageHeaders, renderErrorPage, renderPendingPage } from './oauth-pages';
import type { AuthorizeOutcome, OAuthService, TokenOutcome } from './oauth-service';
import type { PublicMcpConfig } from './public-mcp-config';

// The public MCP route's listener (docs/guides/mcp.md#public-route): plain
// HTTP behind the operator's TLS front. It reads no client address or
// forwarded header, and logs nothing a request carries.

// requests open at once
const MAX_OPEN = 64;

// a JSON-RPC message, a file write's content included (4 MiB as text)
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// a token request or a page's form
const MAX_FORM_BYTES = 16 * 1024;

// seconds a request may sit idle; /mcp has none, as a tool call can run for
// minutes
const IDLE_TIMEOUT_S = 30;
const NOT_FOUND = 'not found';

export interface PublicListenerDeps {
  readonly config: PublicMcpConfig;
  readonly oauth: OAuthService;
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
  const state = { open: 0 };
  const issuer = deps.oauth.issuer;
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
    const method = request.method;

    if (path === MCP_PATH) {
      server?.timeout(request, 0);

      return deps.mcp.handle(request);
    }

    if (
      method === 'GET' &&
      (path === PROTECTED_RESOURCE_PATH || path === `${PROTECTED_RESOURCE_PATH}/mcp`)
    ) {
      return buildJson(buildProtectedResourceMetadata(issuer, deps.oauth.resource));
    }

    if (method === 'GET' && path === AUTHORIZATION_SERVER_PATH) {
      return buildJson(buildAuthorizationServerMetadata(issuer));
    }

    if (method === 'GET' && path === AUTHORIZE_PATH) {
      const query = url.searchParams;

      const outcome = await deps.oauth.authorize({
        responseType: query.get('response_type'),
        clientId: query.get('client_id'),
        redirectUri: query.get('redirect_uri'),
        codeChallenge: query.get('code_challenge'),
        codeChallengeMethod: query.get('code_challenge_method'),
        state: query.get('state'),
        scope: query.get('scope'),
        resource: query.get('resource'),
      });

      return buildAuthorizeResponse(outcome, deps.config.host);
    }

    if (method === 'POST' && path === AUTHORIZE_PATH) {
      if (!isSameOriginForm(request, issuer)) {
        return buildAuthorizeResponse(
          { kind: 'error-page', error: 'bad_request' },
          deps.config.host,
        );
      }

      const form = await readForm(request);

      const action = form?.get('action');

      if (form === null || (action !== 'continue' && action !== 'allow' && action !== 'deny')) {
        return buildAuthorizeResponse(
          { kind: 'error-page', error: 'bad_request' },
          deps.config.host,
        );
      }

      const outcome = deps.oauth.finish(form.get('id') ?? '', form.get('signature') ?? '', action);

      return buildAuthorizeResponse(outcome, deps.config.host);
    }

    if (method === 'POST' && path === TOKEN_PATH) {
      const form = await readForm(request);

      if (form === null) {
        return buildTokenReply({
          status: 400,
          body: { error: 'invalid_request', error_description: 'send a form' },
        });
      }

      const outcome = await deps.oauth.exchange(form);

      return buildTokenReply(outcome);
    }

    if (method === 'POST' && path === REVOKE_PATH) {
      const form = await readForm(request);

      if (form === null) {
        return buildTokenReply({
          status: 400,
          body: { error: 'invalid_request', error_description: 'send a form' },
        });
      }

      const outcome = await deps.oauth.revokeToken(form);

      return outcome === null
        ? new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } })
        : buildTokenReply(outcome);
    }

    return buildNotFound();
  };

  return async (request, server) => {
    if (state.open >= MAX_OPEN) {
      return new Response('too many requests', { status: 429, headers: { 'retry-after': '1' } });
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

function buildAuthorizeResponse(outcome: Readonly<AuthorizeOutcome>, issuerHost: string): Response {
  if (outcome.kind === 'page') {
    return new Response(renderPendingPage(outcome.view, issuerHost), {
      status: 200,
      headers: buildPageHeaders(new URL(outcome.view.redirectUri).origin),
    });
  }

  if (outcome.kind === 'redirect') {
    return new Response(null, {
      status: 302,
      headers: {
        location: outcome.location,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    });
  }

  if (outcome.kind === 'error-page') {
    return new Response(renderErrorPage(outcome.error), {
      status: 400,
      headers: buildPageHeaders(null),
    });
  }

  const headers = buildPageHeaders(null);

  headers.set('retry-after', String(outcome.retryS));

  return new Response(renderErrorPage('bad_request'), { status: 429, headers });
}

function buildTokenReply(outcome: Readonly<TokenOutcome>): Response {
  return Response.json(outcome.body, {
    status: outcome.status,
    headers: {
      'cache-control': 'no-store',
      pragma: 'no-cache',
      ...(outcome.status === 401 && { 'www-authenticate': 'Basic realm="imp"' }),
      ...(outcome.status === 429 && { 'retry-after': '2' }),
    },
  });
}

// a urlencoded form of at most MAX_FORM_BYTES; null for anything else
async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get('content-type') ?? '';

  if (!type.startsWith('application/x-www-form-urlencoded') || request.body === null) {
    return null;
  }

  const body: ReadableStream<Uint8Array> = request.body;
  const chunks: Uint8Array[] = [];
  let total = 0;

  // leaving the loop early cancels the rest of the body
  for await (const chunk of body) {
    total += chunk.byteLength;

    if (total > MAX_FORM_BYTES) {
      return null;
    }

    chunks.push(chunk);
  }

  return new URLSearchParams(new TextDecoder().decode(Buffer.concat(chunks)));
}

// A form a page on another origin posts never counts. A browser names the
// page's origin, or sends Origin null with Sec-Fetch-Site, which it sets
// itself and no page can change.
function isSameOriginForm(request: Request, issuer: string): boolean {
  const origin = request.headers.get('origin');

  if (origin === issuer) {
    return true;
  }

  return origin === 'null' && request.headers.get('sec-fetch-site') === 'same-origin';
}

function buildJson(body: unknown): Response {
  return Response.json(body, { headers: { 'cache-control': 'no-store' } });
}

function buildNotFound(): Response {
  return new Response(NOT_FOUND, { status: 404 });
}
