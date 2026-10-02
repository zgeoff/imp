import { ORPCError } from '@orpc/server';
import type { Server, WebSocketHandler } from 'bun';
import { removeSessionCookie } from '../auth/session-cookie';
import type { Config } from '../config';
import type { ImpRecord } from '../db/imps';
import { listImps } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { ImpRuntime } from '../imps/imp-runtime';
import { createSemaphore } from '../imps/semaphore';
import { deriveSlotAddress } from '../net/addressing';
import { readErrorMessage } from '../read-error-message';
import { buildErrorPage } from './error-pages';
import { parseHostName } from './parse-host-name';

// hop-by-hop headers (RFC 9110 7.6.1) stay on their own hop
const HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

const UPSTREAM_SOCKET_TIMEOUT_MS = 10_000;

interface SocketData {
  readonly upstream: WebSocket;
  readonly release: () => void;

  // upstream messages that arrive before the client socket opens
  readonly pending: (string | ArrayBuffer)[];
  readonly handleEarlyMessage: (event: MessageEvent<string | ArrayBuffer>) => void;
}

interface WakeProxyDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly imps: Pick<ImpRuntime, 'requireRunning' | 'tracker' | 'recordActivity'>;
  readonly log: (message: string) => void;
}

// Where a request goes: an imp, which it wakes, impd's own API, or nowhere
export type ProxyRoute =
  | { readonly kind: 'imp'; readonly name: string }
  | { readonly kind: 'api' }
  | { readonly kind: 'none'; readonly hint: string };

export interface ProxyListenOptions {
  readonly port: number;
  readonly hostname?: string;
  readonly tls?: { readonly key: string; readonly cert: string };

  // lets a listener with a new certificate bind next to the old one
  readonly reusePort?: boolean;
  readonly route: (request: Request) => ProxyRoute;
}

type ProxyServer = Server<SocketData>;

// one request on its way to an address behind the proxy
interface UpstreamOptions {
  // ends the connection's count in the activity tracker
  readonly release: () => void;
  readonly wokeMs: number | null;
  readonly formatFailure: (reason: string) => string;

  // impd's own API needs the dashboard's session; an imp must never get it
  readonly keepSession: boolean;
}

export interface WakeProxy {
  // one listener per imp on portBase + slot; call after a create or destroy
  readonly syncListeners: () => Promise<void>;

  // another listener with the same proxy behind it; the caller stops it
  readonly startListener: (options: ProxyListenOptions) => ProxyServer;
  readonly stop: () => Promise<void>;
}

// The wake-on-request proxy (DESIGN 2.11): Host routing on the proxy port and
// one port per imp. A request wakes or boots the imp, then goes to its HTTP
// port; WebSockets are relayed message by message.
export function startWakeProxy(deps: WakeProxyDeps): WakeProxy {
  const listeners = new Map<string, { readonly slot: number; readonly server: ProxyServer }>();
  const failedSlots = new Set<number>();

  const syncSlot = createSemaphore(1);

  const websocket: WebSocketHandler<SocketData> = {
    open: (ws) => {
      const upstream = ws.data.upstream;

      upstream.removeEventListener('message', ws.data.handleEarlyMessage);

      for (const message of ws.data.pending.splice(0)) {
        ws.send(message);
      }

      upstream.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
        ws.send(event.data);
      });

      // no close can come earlier: Bun runs `open` inside server.upgrade,
      // in the same task as the upstream's open event
      upstream.addEventListener('close', (event) => {
        ws.close(toSendableCode(event.code), event.reason);
      });
    },
    message: (ws, message) => {
      ws.data.upstream.send(message);
    },
    close: (ws, code, reason) => {
      ws.data.release();

      if (ws.data.upstream.readyState <= WebSocket.OPEN) {
        ws.data.upstream.close(toSendableCode(code), reason);
      }
    },
  };

  const handleRequest = async (
    request: Request,
    server: ProxyServer,
    route: ProxyRoute,
  ): Promise<Response | undefined> => {
    if (route.kind === 'none') {
      return buildErrorPage(404, route.hint);
    }

    if (route.kind === 'api') {
      return sendUpstream(request, server, `127.0.0.1:${String(deps.config.apiPort)}`, {
        release: () => {
          // impd's own API: nothing to keep awake
        },
        wokeMs: null,
        formatFailure: (reason) => `impd's API did not answer (${reason}).`,
        keepSession: true,
      });
    }

    const name = route.name;

    const opened: { release: () => void } = {
      release: () => {
        // nothing counted yet
      },
    };

    let running: { readonly imp: ImpRecord; readonly wokeMs: number | null };

    try {
      running = await deps.imps.requireRunning(name, (imp) => {
        opened.release = deps.imps.tracker.open(imp.id, 'proxy');
      });
    } catch (error) {
      opened.release();

      return buildWakeErrorPage(name, error);
    }

    const imp = running.imp;
    const wokeMs = running.wokeMs;

    if (wokeMs !== null) {
      const path = new URL(request.url).pathname;

      deps.log(`impd: proxy: ${name} woke in ${String(wokeMs)}ms for ${request.method} ${path}`);
    }

    try {
      await deps.imps.recordActivity(name);
    } catch {
      // the idle loop also counts the open connection
    }

    return sendUpstream(request, server, `${imp.ip}:${String(imp.httpPort)}`, {
      release: opened.release,
      wokeMs,
      formatFailure: (reason) =>
        `${name} is awake, but nothing answered on port ${String(imp.httpPort)} (${reason}).`,
      keepSession: false,
    });
  };

  const sendUpstream = async (
    request: Request,
    server: ProxyServer,
    address: string,
    options: UpstreamOptions,
  ): Promise<Response | undefined> => {
    const wokeMs = options.wokeMs;
    const release = options.release;

    const url = new URL(request.url);

    const target = `${address}${url.pathname}${url.search}`;
    const upstreamHeaders = buildUpstreamHeaders(request, server, options.keepSession);

    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return handleWebSocket(request, server, `ws://${target}`, upstreamHeaders, release);
    }

    try {
      const upstream = await fetch(`http://${target}`, {
        method: request.method,
        headers: upstreamHeaders,
        body: request.body,
        redirect: 'manual',
        decompress: false,
        keepalive: false,
      });

      const headers = new Headers(upstream.headers);

      for (const header of HOP_HEADERS) {
        headers.delete(header);
      }

      if (wokeMs !== null) {
        headers.set('x-imp-wake-ms', String(wokeMs));
      }

      const body = upstream.body === null ? null : buildTrackedBody(upstream.body, release);

      if (body === null) {
        release();
      }

      return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (error) {
      release();

      return buildErrorPage(502, options.formatFailure(readErrorMessage(error)));
    }
  };

  const handleWebSocket = async (
    request: Request,
    server: ProxyServer,
    target: string,
    headers: Readonly<Headers>,
    release: () => void,
  ): Promise<Response | undefined> => {
    const protocols = (request.headers.get('sec-websocket-protocol') ?? '')
      .split(',')
      .map((protocol) => protocol.trim())
      .filter((protocol) => protocol !== '');

    let upstream: WebSocket;
    const pending: (string | ArrayBuffer)[] = [];

    try {
      upstream = await openUpstreamSocket(target, protocols, headers);
    } catch (error) {
      release();

      const reason = readErrorMessage(error);

      return buildErrorPage(502, `The WebSocket to ${target} failed: ${reason}`);
    }

    const handleEarlyMessage = (event: MessageEvent<string | ArrayBuffer>): void => {
      pending.push(event.data);
    };

    upstream.addEventListener('message', handleEarlyMessage);

    const upgraded = server.upgrade(request, {
      data: { upstream, pending, handleEarlyMessage, release },
      ...(upstream.protocol !== '' && { headers: { 'sec-websocket-protocol': upstream.protocol } }),
    });

    if (!upgraded) {
      upstream.close();

      release();

      return new Response('websocket upgrade failed', { status: 400 });
    }

    return undefined;
  };

  const startListener = (options: ProxyListenOptions): ProxyServer =>
    Bun.serve<SocketData>({
      port: options.port,
      ...(options.hostname !== undefined && { hostname: options.hostname }),
      ...(options.tls !== undefined && { tls: options.tls }),
      ...(options.reusePort === true && { reusePort: true }),
      idleTimeout: 0,
      fetch: (request, server) => handleRequest(request, server, options.route(request)),
      websocket,
    });

  const hint = `Use http://<imp>.imp.localhost:${String(deps.config.proxyPort)}/.`;

  const main = startListener({
    port: deps.config.proxyPort,
    route: (request) => {
      const name = parseHostName(request.headers.get('host'));

      return name === null ? { kind: 'none', hint } : { kind: 'imp', name };
    },
  });

  deps.log(`impd: proxy on :${String(deps.config.proxyPort)}`);

  // one at a time: a pass that read the imps before a destroy must not
  // re-add a listener after a later pass removed it
  const runListenerSync = (): Promise<void> =>
    syncSlot.run(async () => {
      const imps = await listImps(deps.db);

      const wanted = new Map(imps.map((imp) => [imp.id, imp]));

      for (const [id, listener] of listeners) {
        if (wanted.get(id)?.slot !== listener.slot) {
          await listener.server.stop(true);

          listeners.delete(id);
        }
      }

      for (const imp of imps) {
        if (listeners.has(imp.id)) {
          continue;
        }

        const port = deriveSlotAddress(imp.slot, deps.config).tailnetPort;

        try {
          const route: ProxyRoute = { kind: 'imp', name: imp.name };

          listeners.set(imp.id, {
            slot: imp.slot,
            server: startListener({ port, route: () => route }),
          });

          failedSlots.delete(imp.slot);
        } catch (error) {
          if (!failedSlots.has(imp.slot)) {
            failedSlots.add(imp.slot);

            deps.log(
              `impd: proxy: cannot listen on :${String(port)} for ${imp.name}: ${String(error)}`,
            );
          }
        }
      }
    });

  return {
    syncListeners: runListenerSync,
    startListener,
    stop: async () => {
      await Promise.all([
        main.stop(true),
        ...[...listeners.values()].map((listener) => listener.server.stop(true)),
      ]);

      listeners.clear();
    },
  };
}

function buildUpstreamHeaders(
  request: Request,
  server: ProxyServer,
  keepSession: boolean,
): Headers {
  const headers = new Headers(request.headers);

  for (const header of HOP_HEADERS) {
    headers.delete(header);
  }

  const socketHeaders = [...headers.keys()].filter((header) => header.startsWith('sec-websocket-'));

  for (const header of socketHeaders) {
    headers.delete(header);
  }

  // The dashboard's session goes to every port of this host, imps' ports
  // too; an imp must not get it. An imp can still set a cookie by that name
  // and so log the dashboard out, which costs a login and nothing more.
  const cookie = headers.get('cookie');
  const kept = cookie === null || keepSession ? cookie : removeSessionCookie(cookie);

  if (kept === null) {
    headers.delete('cookie');
  } else {
    headers.set('cookie', kept);
  }

  // one request per upstream connection: an idle keep-alive socket would
  // show as an established TCP connection in the guest and keep it awake
  headers.set('connection', 'close');

  const client = server.requestIP(request)?.address;

  if (client !== undefined) {
    const forwarded = request.headers.get('x-forwarded-for');
    const chain = forwarded === null ? client : `${forwarded}, ${client}`;

    headers.set('x-forwarded-for', chain);
  }

  headers.set('x-forwarded-host', request.headers.get('host') ?? '');

  // https on the domain listeners: Bun gives a TLS request an https URL
  headers.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''));

  return headers;
}

// counts the connection until the body is sent or the client goes away
function buildTrackedBody(source: ReadableStream<Uint8Array>, release: () => void) {
  const reader = source.getReader();

  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const chunk = await reader.read();

        if (chunk.done) {
          release();

          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        release();

        controller.error(error);
      }
    },
    cancel: async (reason) => {
      release();

      await reader.cancel(reason);
    },
  });
}

function openUpstreamSocket(
  target: string,
  protocols: readonly string[],
  headers: Readonly<Headers>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target, {
      protocols: [...protocols],
      headers: Object.fromEntries(headers),
    });

    socket.binaryType = 'arraybuffer';

    const timer = setTimeout(() => {
      socket.close();

      reject(new Error('timed out'));
    }, UPSTREAM_SOCKET_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('connection failed'));
    });
  });
}

// 1005, 1006 and 1015 describe a close; they cannot be sent in one
function toSendableCode(code: number): number {
  return code === 1000 ||
    (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
    ? code
    : 1000;
}

function buildWakeErrorPage(name: string, error: unknown): Response {
  if (error instanceof ORPCError && error.code === 'NOT_FOUND') {
    return buildErrorPage(404, `There is no imp named ${name}.`);
  }

  const reason = readErrorMessage(error);

  return buildErrorPage(503, `${name} could not wake: ${reason}`);
}
