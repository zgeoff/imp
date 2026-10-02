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
  readonly stop: () => Promise<void>;
}

// a running server, as far as these listeners use one
interface Listener {
  readonly stop: (closeActiveConnections?: boolean) => Promise<void>;
}

// the wake proxy, or a stand-in in tests
export interface ProxyListen {
  readonly startListener: (options: ProxyListenOptions) => Listener;
}

interface HttpsListenersOptions {
  readonly proxy: ProxyListen;
  readonly domain: string;
  readonly httpsPort: number;
  readonly httpPort: number;
  readonly log: (message: string) => void;
}

interface AddressListeners {
  tls: Listener | null;
  redirect: Listener | null;
}

// The listeners on the domain, per address: TLS on httpsPort into the wake
// proxy, and a redirect to it on httpPort. One wildcard certificate covers
// every name, so SNI needs no choice; the Host header picks the imp.
export function createHttpsListeners(options: HttpsListenersOptions): HttpsListeners {
  const domain = options.domain;
  const httpsPort = options.httpsPort;
  const log = options.log;

  const byAddress = new Map<string, AddressListeners>();

  // `<address>:<port>` that failed to bind, logged once until it binds
  const failed = new Set<string>();

  let certificate: Certificate | null = null;
  const hint = `Use https://<imp>.${domain}/.`;

  const resolveRoute = (request: Request): ProxyRoute => {
    const parsed = parseDomainHost(request.headers.get('host'), domain);

    if (parsed === null) {
      return { kind: 'none', hint };
    }

    return parsed.kind === 'apex' ? { kind: 'api' } : parsed;
  };

  const tryBind = <T>(address: string, port: number, start: () => T): T | null => {
    const key = `${address}:${String(port)}`;

    try {
      const server = start();

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
    tryBind(address, httpsPort, () =>
      options.proxy.startListener({
        hostname: address,
        port: httpsPort,
        tls: { key: current.keyPem, cert: current.chainPem },
        reusePort: true,
        route: resolveRoute,
      }),
    );

  const startRedirect = (address: string): Listener | null =>
    tryBind(address, options.httpPort, () =>
      Bun.serve({
        hostname: address,
        port: options.httpPort,
        fetch: (request) => buildRedirect(request, domain, httpsPort, hint),
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
