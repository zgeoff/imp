import { buildErrorPage } from '../proxy/error-pages';
import type { ProxyListenOptions, ProxyRoute } from '../proxy/wake-proxy';
import { readErrorMessage } from '../read-error-message';
import type { Certificate } from './acme/cert-store';
import type { DomainRoute } from './parse-domain-host';
import { parseDomainHost } from './parse-domain-host';

export interface HttpsListeners {
  // serves this certificate from now on; open connections keep the old one
  readonly setCertificate: (certificate: Certificate) => void;

  // the addresses to listen on: loopback and the tailnet IP, never 0.0.0.0,
  // so a port published to the internet never reaches these listeners
  readonly setAddresses: (addresses: readonly string[]) => void;

  // the ports that running listeners hold; null while none does
  readonly readPorts: () => { readonly https: number | null; readonly http: number | null };
  readonly stop: () => Promise<void>;
}

// a running server, as far as these listeners use one
interface Listener {
  readonly port: number | undefined;
  readonly stop: (closeActiveConnections?: boolean) => Promise<void>;
}

// the wake proxy, or a stand-in in tests
export interface ProxyListen {
  readonly startListener: (options: ProxyListenOptions) => Listener;
}

interface HttpsListenersOptions {
  readonly proxy: ProxyListen;
  readonly domain: string;

  // 0 takes a free port at the first bind, which every later bind and the
  // redirect then keep
  readonly httpsPort: number;
  readonly httpPort: number;
  readonly log: (message: string) => void;

  // the public listeners serve public imps only: no API on the bare
  // domain, and a tailnet-only imp is a 404 like an unknown one
  readonly scope: ListenerScope;
}

export type ListenerScope =
  | { readonly kind: 'tailnet' }
  | {
      readonly kind: 'public';

      // the imp's route, or null while it is not public; it takes a slot
      // and maybe a wake, which the request gives back as it ends
      readonly routeImp: (name: string, request: Request) => Promise<ProxyRoute | null>;

      // whether the name is a public imp, and nothing else: the redirect
      // only answers, so it takes no slot and no wake
      readonly isPublic: (name: string) => Promise<boolean>;
    };

interface AddressListeners {
  tls: Listener | null;
  redirect: Listener | null;
}

// The listeners on the domain, per address: TLS on httpsPort into the wake
// proxy, and a redirect to it on httpPort. One wildcard certificate covers
// every name, so SNI needs no choice; the Host header picks the imp.
export function createHttpsListeners(options: HttpsListenersOptions): HttpsListeners {
  const domain = options.domain;
  const log = options.log;
  const ports = { https: options.httpsPort, http: options.httpPort };

  const byAddress = new Map<string, AddressListeners>();

  // `<address>:<port>` that failed to bind, logged once until it binds
  const failed = new Set<string>();

  let certificate: Certificate | null = null;
  const scope = options.scope;

  // Docker publishes the public listener as 443, whatever its port inside
  const readRedirectPort = (): number => (scope.kind === 'public' ? 443 : ports.https);

  // the public 404 names no imp and no use of the domain
  const hint = scope.kind === 'public' ? 'No public imp here.' : `Use https://<imp>.${domain}/.`;

  const resolveRoute = async (request: Request): Promise<ProxyRoute> => {
    const parsed = parseDomainHost(request.headers.get('host'), domain);

    if (parsed === null) {
      return { kind: 'none', hint };
    }

    if (scope.kind === 'tailnet') {
      return parsed.kind === 'apex' ? { kind: 'api' } : parsed;
    }

    const route = parsed.kind === 'imp' ? await scope.routeImp(parsed.name, request) : null;

    return route ?? { kind: 'none', hint };
  };

  // a redirect that answered for a tailnet-only imp would tell the internet
  // the name exists
  const checkRedirect = (request: Request): Promise<boolean> => {
    const parsed = parseDomainHost(request.headers.get('host'), domain);

    if (parsed === null || scope.kind === 'tailnet') {
      return Promise.resolve(parsed !== null);
    }

    return parsed.kind === 'imp' ? scope.isPublic(parsed.name) : Promise.resolve(false);
  };

  const tryBind = (
    address: string,
    kind: 'https' | 'http',
    start: () => Listener,
  ): Listener | null => {
    const key = `${address}:${String(ports[kind])}`;

    try {
      const server = start();

      ports[kind] = server.port ?? ports[kind];

      if (failed.delete(key)) {
        log(`impd: https: listening on ${key}`);
      }

      return server;
    } catch (error) {
      if (!failed.has(key)) {
        failed.add(key);

        log(`impd: https: cannot listen on ${key}: ${readErrorMessage(error)}`);
      }

      return null;
    }
  };

  const startTls = (address: string, current: Certificate): Listener | null =>
    tryBind(address, 'https', () =>
      options.proxy.startListener({
        hostname: address,
        port: ports.https,
        tls: { key: current.keyPem, cert: current.chainPem },
        reusePort: true,
        route: resolveRoute,
      }),
    );

  const startRedirect = (address: string): Listener | null =>
    tryBind(address, 'http', () =>
      Bun.serve({
        hostname: address,
        port: ports.http,
        fetch: async (request) => {
          const isRedirected = await checkRedirect(request);

          return isRedirected
            ? buildRedirect(request, domain, readRedirectPort(), hint)
            : buildErrorPage(404, hint);
        },
      }),
    );

  // starts whatever is missing on an address; nothing serves before the
  // first certificate
  const startMissing = (address: string): void => {
    const listeners = byAddress.get(address);

    if (certificate === null || listeners === undefined) {
      return;
    }

    listeners.tls ??= startTls(address, certificate);
    listeners.redirect ??= startRedirect(address);
  };

  return {
    setCertificate: (next) => {
      certificate = next;

      for (const [address, listeners] of byAddress) {
        const old = listeners.tls;

        // the new listener binds next to the old one (SO_REUSEPORT), then
        // the old one stops taking connections and lets its own finish;
        // Bun cannot swap the certificate of a running server
        const fresh = old === null ? null : startTls(address, next);

        if (old !== null && fresh !== null) {
          listeners.tls = fresh;
          void old.stop(false);
        }

        startMissing(address);
      }
    },
    setAddresses: (addresses) => {
      for (const [address, listeners] of byAddress) {
        if (!addresses.includes(address)) {
          void listeners.tls?.stop(true);
          void listeners.redirect?.stop(true);
          byAddress.delete(address);
        }
      }

      for (const address of addresses) {
        if (!byAddress.has(address)) {
          byAddress.set(address, { tls: null, redirect: null });
        }

        startMissing(address);
      }
    },
    readPorts: () => {
      const running = [...byAddress.values()];

      return {
        https: running.some((listeners) => listeners.tls !== null) ? ports.https : null,
        http: running.some((listeners) => listeners.redirect !== null) ? ports.http : null,
      };
    },
    stop: async () => {
      const servers = [...byAddress.values()].flatMap((listeners) => [
        listeners.tls,
        listeners.redirect,
      ]);

      byAddress.clear();

      await Promise.all(servers.map((server) => server?.stop(true) ?? Promise.resolve()));
    },
  };
}

// http://<name>.<domain>/path to the same on https; the target is built
// from the parsed name, never from the raw Host header
function buildRedirect(
  request: Request,
  domain: string,
  httpsPort: number,
  hint: string,
): Response {
  const parsed = parseDomainHost(request.headers.get('host'), domain);

  if (parsed === null) {
    return buildErrorPage(404, hint);
  }

  const url = new URL(request.url);

  const port = httpsPort === 443 ? '' : `:${String(httpsPort)}`;

  return new Response(null, {
    status: 308,
    headers: {
      location: `https://${buildHostname(parsed, domain)}${port}${url.pathname}${url.search}`,
    },
  });
}

function buildHostname(route: DomainRoute, domain: string): string {
  return route.kind === 'apex' ? domain : `${route.name}.${domain}`;
}
