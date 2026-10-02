import type { TailscaleStatus } from '../net/tailscale-status';
import type { Ticker } from '../process/ticker';
import { startTicker } from '../process/ticker';
import { readErrorMessage } from '../read-error-message';
import type { IssueCertificate } from './acme/acme-issuer';
import { createCertManager } from './acme/cert-manager';
import type { CertStore } from './acme/cert-store';
import type { DnsProvider } from './dns/dns-provider';
import type { HttpsConfig } from './https-config';
import { createHttpsListeners } from './https-listeners';
import type { ProxyListen } from './https-listeners';

const RENEW_INTERVAL_MS = 10 * 60_000;

// as often as the proxy's own listener sync: a new tailnet IP is picked up
// within half a minute
const ADDRESS_INTERVAL_MS = 30_000;

export interface HttpsService {
  // returns at once: issuance runs in the background, so a CA or DNS
  // outage never holds up impd
  readonly start: () => void;
  readonly stop: () => Promise<void>;
}

interface HttpsServiceDeps {
  readonly config: HttpsConfig;
  readonly store: CertStore;
  readonly issue: IssueCertificate;
  readonly dns: DnsProvider;
  readonly proxy: ProxyListen;

  // null when the host is on no tailnet: the domain then answers only on
  // loopback in the host container
  readonly readTailscale: (() => Promise<TailscaleStatus>) | null;
  readonly readServePorts: () => Promise<readonly number[]>;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

// HTTPS on the domain (docs/guides/https.md): the certificate, its renewal,
// the listeners on loopback and the tailnet IP, and the DNS records that
// point the domain at that IP.
export function createHttpsService(deps: HttpsServiceDeps): HttpsService {
  const config = deps.config;
  const domain = config.domain;
  const log = deps.log;

  const certs = createCertManager({
    domain,
    store: deps.store,
    issue: deps.issue,
    now: deps.now,
    log,
  });

  const listeners = createHttpsListeners({
    proxy: deps.proxy,
    domain,
    httpsPort: config.httpsPort,
    httpPort: config.httpPort,
    log,
  });

  // the IP the A records were last set to, the one checked for a
  // conflicting `tailscale serve`, and whether stop ran: a renewal that
  // finishes later must not start listeners again
  const state: { recordsIp: string | null; checkedServeFor: string | null; stopped: boolean } = {
    recordsIp: null,
    checkedServeFor: null,
    stopped: false,
  };

  const tickers: Ticker[] = [];

  const runRenewal = async (): Promise<void> => {
    const certificate = await certs.renew();

    if (certificate !== null && !state.stopped) {
      listeners.setCertificate(certificate);
    }
  };

  // The records follow the tailnet IP, which changes when Tailscale deletes
  // an ephemeral node that stayed offline (docs/guides/tailscale.md).
  const setRecords = async (ip: string): Promise<void> => {
    try {
      await deps.dns.setA(domain, ip);
      await deps.dns.setA(`*.${domain}`, ip);

      state.recordsIp = ip;

      log(`impd: https: ${domain} and *.${domain} point at ${ip}`);
    } catch (error) {
      log(`impd: https: cannot point ${domain} at ${ip}: ${readErrorMessage(error)}`);
    }
  };

  const checkServePorts = async (ip: string): Promise<void> => {
    state.checkedServeFor = ip;

    const held = await deps.readServePorts();

    for (const port of [config.httpsPort, config.httpPort]) {
      if (held.includes(port)) {
        log(
          `impd: https: warning: tailscale serve holds tailnet port ${String(port)}, so impd never sees that traffic; remove it with \`tailscale serve --https=${String(port)} off\` or \`tailscale serve reset\``,
        );
      }
    }
  };

  const updateAddresses = async (): Promise<void> => {
    const status = deps.readTailscale === null ? null : await deps.readTailscale();
    const ip = status?.ip ?? null;

    if (state.stopped) {
      return;
    }

    if (ip === null) {
      listeners.setAddresses(['127.0.0.1']);

      return;
    }

    listeners.setAddresses(['127.0.0.1', ip]);

    if (state.checkedServeFor !== ip) {
      await checkServePorts(ip);
    }

    if (state.recordsIp !== ip) {
      await setRecords(ip);
    }
  };

  return {
    start: () => {
      const certificate = certs.load();

      if (certificate !== null) {
        listeners.setCertificate(certificate);
      }

      if (deps.readTailscale === null) {
        log(
          `impd: https: no tailnet; https://<imp>.${domain} answers only inside the host container`,
        );
      }

      // the first pass now, not a tick from now
      void runLogged('addresses', updateAddresses, log);
      void runLogged('renewal', runRenewal, log);

      tickers.push(
        startTicker('https renewal', RENEW_INTERVAL_MS, runRenewal, log),
        startTicker('https addresses', ADDRESS_INTERVAL_MS, updateAddresses, log),
      );
    },
    stop: async () => {
      state.stopped = true;

      await Promise.all(tickers.map((ticker) => ticker.stop()));
      await listeners.stop();
    },
  };
}

async function runLogged(
  label: string,
  task: () => Promise<void>,
  log: (message: string) => void,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    log(`impd: https: ${label}: ${readErrorMessage(error)}`);
  }
}
