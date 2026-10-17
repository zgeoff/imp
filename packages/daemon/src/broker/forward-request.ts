import type { AuditRefusal, GrantFilter } from '@impz/api';
import type { NewAuditEntry } from '../db/broker-audit';
import { isRequestInFilter } from './is-request-in-filter';

// One terminated request, sent on to the real host with the credential.

// what the broker adds for one host of one imp
export interface Credential {
  readonly secretName: string;
  readonly header: string;
  readonly value: string;

  // the rule's own origin (http or https), or null for https://<host>
  readonly upstream: string | null;

  // the grant's method and path filter, or null for the whole host
  readonly filter: GrantFilter | null;

  // for an oauth secret, when the refresh that gave this access token ran
  // (ms, null before the first); null for every other kind
  readonly oauth: { readonly refreshedAt: number | null } | null;
}

// where requests for a host go: the rule's upstream, else a test upstream
// (test-upstreams.ts), else https://<host>; with the extra CA a test
// upstream is signed by
export interface Upstream {
  readonly origin: string;
  readonly ca: readonly string[] | null;
}

// what the forwarder hands fetch: Bun's init, narrowed to what it sets
interface UpstreamInit {
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

  // After the host answered 401 to an oauth access token: true once a newer
  // token is in place. The service can revoke a token before its expiry
  // (docs/guides/connectors.md#refresh-after-a-401). Never rejects.
  readonly refreshAfterRejection?: (
    secretName: string,
    refreshedAt: number | null,
  ) => Promise<boolean>;
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

// Some frameworks run the method one of these names in place of the
// request's own, so on a filtered grant they could turn an allowed POST into
// a method the filter refused.
const METHOD_OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override'];
const MAX_AUDIT_PATH = 512;

// The handler for a terminator bound to one imp and one host. The URL is the
// upstream's origin plus the request's path: neither the Host header nor an
// absolute-form target can send the credential elsewhere.
export function createForwarder(deps: ForwardDeps): (request: Request) => Promise<Response> {
  const fetchUpstream = deps.fetch ?? sendUpstream;

  return async (request) => {
    const started = performance.now();

    const url = new URL(request.url);

    // answered before any credential is read, with an audit row that keeps
    // nothing from the request's headers or body
    const sendRefusal = (status: number, message: string, reason: AuditRefusal): Response => {
      deps.recordAudit({
        impId: deps.impId,
        secretName: null,
        at: new Date(),
        method: request.method,
        host: deps.host,
        path: url.pathname.slice(0, MAX_AUDIT_PATH),
        status,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: Math.round(performance.now() - started),
        reason,
      });

      return new Response(`${message}\n`, { status });
    };

    if (readHostName(request.headers.get('host')) !== deps.host) {
      return sendRefusal(421, `this connection is for ${deps.host}`, 'wrong-host');
    }

    // answered at once, so a client that tries a WebSocket first falls back to
    // HTTPS without waiting on a stripped upgrade
    if (isWebSocketUpgrade(request.headers)) {
      return sendRefusal(
        426,
        'websocket upgrades are not supported through the broker',
        'websocket',
      );
    }

    const credential = await deps.findCredential(deps.impId, deps.host);

    if (credential === null) {
      return sendRefusal(403, `no credential is granted for ${deps.host}`, 'no-grant');
    }

    // read with the credential, so a grant changed since applies to this
    // request; refused before the credential goes into any header
    if (
      credential.filter !== null &&
      !isRequestInFilter(credential.filter, request.method, url.pathname)
    ) {
      return sendRefusal(
        403,
        `the grant for ${deps.host} does not cover ${request.method} ${url.pathname}`,
        'outside-filter',
      );
    }

    // one send upstream with one credential, with its own audit row
    const sendWith = async (sent: Readonly<Credential>): Promise<Response> => {
      const counts = { requestBytes: 0, responseBytes: 0 };

      const sendAudit = (status: number): void => {
        deps.recordAudit({
          impId: deps.impId,
          secretName: sent.secretName,
          at: new Date(),
          method: request.method,
          host: deps.host,
          path: url.pathname.slice(0, MAX_AUDIT_PATH),
          status,
          requestBytes: counts.requestBytes,
          responseBytes: counts.responseBytes,
          durationMs: Math.round(performance.now() - started),
          reason: null,
        });
      };

      // The rule's upstream wins, and it came with the credential, so a rebind
      // or a revoke applies to the next request. It is verified against the
      // system roots when https, and sent with no TLS when http.
      const upstream: Upstream =
        sent.upstream === null
          ? deps.resolveUpstream(deps.host)
          : { origin: sent.upstream, ca: null };

      const headers = buildEndToEndHeaders(request.headers);

      headers.delete('host');

      if (sent.filter !== null) {
        for (const name of METHOD_OVERRIDE_HEADERS) {
          headers.delete(name);
        }
      }

      headers.set(sent.header, sent.value);

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

    const response = await sendWith(credential);

    if (
      response.status !== 401 ||
      credential.oauth === null ||
      deps.refreshAfterRejection === undefined
    ) {
      return response;
    }

    const refreshing = deps.refreshAfterRejection(
      credential.secretName,
      credential.oauth.refreshedAt,
    );

    // A body was streamed upstream and is gone, so only a request without
    // one is sent again; the guest's next request gets the new token.
    if (request.body !== null) {
      return response;
    }

    if (!(await refreshing)) {
      return response;
    }

    // read again, so the retry follows a revoke, a rebind or a new filter
    const renewed = await deps.findCredential(deps.impId, deps.host);

    if (
      renewed === null ||
      renewed.oauth === null ||
      renewed.oauth.refreshedAt === credential.oauth.refreshedAt ||
      (renewed.filter !== null && !isRequestInFilter(renewed.filter, request.method, url.pathname))
    ) {
      return response;
    }

    // an upstream that hung up mid-body fails the cancel; the 401 is
    // discarded either way, and the retry goes on
    try {
      await response.body?.cancel();
    } catch {}

    return sendWith(renewed);
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
