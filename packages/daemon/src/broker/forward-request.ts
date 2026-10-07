import type { NewAuditEntry } from '../db/broker-audit';

// One terminated request, sent on to the real host with the credential.

// what the broker adds for one host of one imp
export interface Credential {
  readonly secretName: string;
  readonly header: string;
  readonly value: string;

  // the rule's own origin (http or https), or null for https://<host>
  readonly upstream: string | null;
}

// where requests for a host go: the rule's upstream, else a test upstream
// (test-upstreams.ts), else https://<host>; with the extra CA a test
// upstream is signed by
export interface Upstream {
  readonly origin: string;
  readonly ca: readonly string[] | null;
}

// what the forwarder hands fetch: Bun's init, narrowed to what it sets
export interface UpstreamInit {
  readonly method: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly redirect: 'manual';
  readonly decompress: false;
  readonly tls?: { readonly ca: readonly string[] };
}

export type UpstreamFetch = (url: string, init: UpstreamInit) => Promise<Response>;

export interface ForwardDeps {
  readonly impId: string;
  readonly host: string;

  // null once the grant is gone: a terminator can outlive it by a request
  readonly findCredential: (impId: string, host: string) => Promise<Credential | null>;
  readonly resolveUpstream: (host: string) => Upstream;
  readonly recordAudit: (entry: NewAuditEntry) => void;
  readonly fetch?: UpstreamFetch;
}

// Per RFC 9110 these describe one connection, not the message; the proxy
// ones are the guest's to its proxy. `expect` is answered here.
const HOP_HEADERS = [
  'connection',
  'expect',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

const MAX_AUDIT_PATH = 512;

// The handler for a terminator bound to one imp and one host. The URL is the
// upstream's origin plus the request's path: neither the Host header nor an
// absolute-form target can send the credential elsewhere.
export function createForwarder(deps: ForwardDeps): (request: Request) => Promise<Response> {
  const fetchUpstream = deps.fetch ?? sendUpstream;

  return async (request) => {
    const started = performance.now();

    const url = new URL(request.url);

    if (readHostName(request.headers.get('host')) !== deps.host) {
      return new Response(`this connection is for ${deps.host}\n`, { status: 421 });
    }

    // answered at once, so a client that tries a WebSocket first falls back to
    // HTTPS without waiting on a stripped upgrade
    if (isWebSocketUpgrade(request.headers)) {
      return new Response('websocket upgrades are not supported through the broker\n', {
        status: 426,
      });
    }

    const credential = await deps.findCredential(deps.impId, deps.host);

    if (credential === null) {
      return new Response(`no credential is granted for ${deps.host}\n`, { status: 403 });
    }

    const counts = { requestBytes: 0, responseBytes: 0 };

    const sendAudit = (status: number): void => {
      deps.recordAudit({
        impId: deps.impId,
        secretName: credential.secretName,
        at: new Date(),
        method: request.method,
        host: deps.host,
        path: url.pathname.slice(0, MAX_AUDIT_PATH),
        status,
        requestBytes: counts.requestBytes,
        responseBytes: counts.responseBytes,
        durationMs: Math.round(performance.now() - started),
      });
    };

    // The rule's upstream wins, and it came with the credential, so a rebind
    // or a revoke applies to the next request. It is verified against the
    // system roots when https, and sent with no TLS when http.
    const upstream: Upstream =
      credential.upstream === null
        ? deps.resolveUpstream(deps.host)
        : { origin: credential.upstream, ca: null };

    const headers = buildEndToEndHeaders(request.headers);

    headers.delete('host');
    headers.set(credential.header, credential.value);

    const body =
      request.body === null
        ? null
        : countBytes(request.body, (bytes) => {
            counts.requestBytes = bytes;
          });

    let response: Response;

    try {
      response = await fetchUpstream(`${upstream.origin}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body,
        redirect: 'manual',

        // the guest asked for the encoding; it gets the bytes as sent
        decompress: false,
        ...(upstream.ca !== null && { tls: { ca: upstream.ca } }),
      });
    } catch {
      sendAudit(502);

      return new Response(`could not reach ${deps.host}\n`, { status: 502 });
    }

    const responseBody =
      response.body === null
        ? null
        : countBytes(response.body, (bytes) => {
            counts.responseBytes = bytes;

            sendAudit(response.status);
          });

    if (responseBody === null) {
      sendAudit(response.status);
    }

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: buildEndToEndHeaders(response.headers),
    });
  };
}

function sendUpstream(url: string, init: UpstreamInit): Promise<Response> {
  const tls = init.tls === undefined ? {} : { tls: { ca: [...init.tls.ca] } };

  return fetch(url, { ...init, ...tls });
}

// `Upgrade: websocket`, in a list of protocols and in any case
function isWebSocketUpgrade(headers: Headers): boolean {
  return (headers.get('upgrade') ?? '')
    .split(',')
    .some((protocol) => protocol.trim().toLowerCase().split('/')[0] === 'websocket');
}

// the host part of a Host header: lowercased, without :443
function readHostName(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const lower = value.toLowerCase();

  return lower.endsWith(':443') ? lower.slice(0, -':443'.length) : lower;
}

// the end-to-end headers: hop-by-hop ones and those Connection names dropped
function buildEndToEndHeaders(source: Headers): Headers {
  const headers = new Headers(source);

  const named = (source.get('connection') ?? '').split(',').map((name) => name.trim());

  for (const name of [...HOP_HEADERS, ...named]) {
    if (name !== '') {
      headers.delete(name);
    }
  }

  return headers;
}

// The same bytes, counted; `onEnd` runs once, at the end, an error or a
// cancel, so a guest that hangs up mid-body still leaves an audit row.
function countBytes(
  body: ReadableStream<Uint8Array>,
  onEnd: (bytes: number) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const state = { bytes: 0, ended: false };

  const emitEnd = (): void => {
    if (!state.ended) {
      state.ended = true;

      onEnd(state.bytes);
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        try {
          const chunk = await reader.read();

          if (chunk.done) {
            emitEnd();

            controller.close();

            return;
          }

          state.bytes += chunk.value.byteLength;

          controller.enqueue(chunk.value);
        } catch (error) {
          emitEnd();

          controller.error(error);
        }
      },
      cancel: async (reason) => {
        emitEnd();

        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
