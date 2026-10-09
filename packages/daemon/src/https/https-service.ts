import type { PublicImp } from '../db/exposure';
import { createSemaphore } from '../imps/semaphore';
import type { TailscaleStatus } from '../net/tailscale-status';
import type { Ticker, TickerTimer } from '../process/ticker';
import { startTicker } from '../process/ticker';
import { readErrorMessage } from '../read-error-message';
import type { IssueCertificate } from './acme/acme-issuer';
import { createCertManager } from './acme/cert-manager';
import type { CertStore, Certificate } from './acme/cert-store';
import { buildPublicOwner } from './dns/dns-provider';
import type { DnsProvider } from './dns/dns-provider';
import type { HttpsConfig } from './https-config';
import { createHttpsListeners } from './https-listeners';
import type { HttpsListeners, ProxyListen } from './https-listeners';
import { createPublicScope } from './public-auth';
import { createPublicLimits } from './public-limits';

const RENEW_INTERVAL_MS = 10 * 60_000;

// as often as the proxy's own listener sync: a new tailnet IP is picked up
// within half a minute
const ADDRESS_INTERVAL_MS = 30_000;

// how the last pass over the public records went
export interface RecordsStatus {
  readonly isOk: boolean;
  readonly error: string | null;
  readonly at: number;
}

export interface HttpsService {
  // returns at once: issuance runs in the background, so a CA or DNS
  // outage never holds up impd
  readonly start: () => void;

  // brings the public A records in line with the public imps; after an
  // expose, an unexpose or a destroy. Never throws: a DNS failure is logged
  // and the next pass tries again.
  readonly updatePublicRecords: () => Promise<RecordsStatus>;

  // the last pass, or null before the first
  readonly readRecordsStatus: () => RecordsStatus | null;

  // the ports the tailnet and public listeners hold; null while none does
  readonly readPorts: () => {
    readonly tailnet: HttpsPorts;
    readonly public: HttpsPorts | null;
  };
  readonly stop: () => Promise<void>;
}

interface HttpsPorts {
  readonly https: number | null;
  readonly http: number | null;
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

  // the public imps, for their A records and the public listeners
  readonly listPublicImps: () => Promise<readonly string[]>;
  readonly findPublicImp: (name: string) => Promise<PublicImp | undefined>;

  // where the renewal, records and address passes wait out their intervals:
  // the runtime's timers unless a test steps them by hand
  readonly timer?: TickerTimer;

  // where the public listeners bind; every address unless a test says
  readonly publicAddress?: string;
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
    scope: { kind: 'tailnet' },
  });

  // every address, on ports of their own that Docker publishes as 443 and
  // 80: which listener a request came in on decides what it may reach
  const publicConfig = config.public;

  const publicListeners: HttpsListeners | null =
    publicConfig === null
      ? null
      : createHttpsListeners({
          proxy: deps.proxy,
          domain,
          httpsPort: publicConfig.httpsPort,
          httpPort: publicConfig.httpPort,
          log,
          scope: createPublicScope(deps.findPublicImp, createPublicLimits(deps.now)),
        });

  const setCertificate = (certificate: Certificate): void => {
    listeners.setCertificate(certificate);
    publicListeners?.setCertificate(certificate);
  };

  // the tailnet IP, the records' IP and their last failure (logged once),
  // the IP checked for `tailscale serve`, and whether stop ran: a renewal
  // that finishes later must not start listeners again
  const state: {
    tailnetIp: string | null;
    recordsIp: string | null;
    recordsError: string | null;
    checkedServeFor: string | null;
    stopped: boolean;
  } = {
    tailnetIp: null,
    recordsIp: null,
    recordsError: null,
    checkedServeFor: null,
    stopped: false,
  };

  const tickers: Ticker[] = [];

  const startTask = (
    label: string,
    intervalMs: number,
    task: () => Promise<void>,
    taskLog: (message: string) => void,
  ): Ticker => startTicker(label, intervalMs, task, taskLog, deps.timer);

  const runRenewal = async (): Promise<void> => {
    const certificate = await certs.renew();

    if (certificate !== null && !state.stopped) {
      setCertificate(certificate);
    }
  };

  // The records follow the tailnet IP, which changes when Tailscale deletes
  // an ephemeral node that stayed offline (docs/guides/tailscale.md).
  const setRecords = async (ip: string): Promise<void> => {
    try {
      await deps.dns.setA(domain, ip);
      await deps.dns.setA(`*.${domain}`, ip);

      state.recordsIp = ip;
      state.recordsError = null;

      log(`impd: https: ${domain} and *.${domain} point at ${ip}`);
    } catch (error) {
      const message = `impd: https: cannot point ${domain} at ${ip}: ${readErrorMessage(error)}`;

      if (message !== state.recordsError) {
        state.recordsError = message;

        log(message);
      }
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

    // a status call that fails reads as no IP; dropping the listener for it
    // would cut every open connection, so only a new IP moves them
    state.tailnetIp = status?.ip ?? state.tailnetIp;

    const ip = state.tailnetIp;

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

  // One `<name>.<domain>` record per public imp, at the public IP; it wins
  // over the tailnet wildcard. The other public records of this domain go,
  // all of them when public mode is off.
  const publicOwner = buildPublicOwner(domain);

  const applyPublicRecords = async (): Promise<void> => {
    const ip = publicConfig?.ip ?? null;
    const wanted = ip === null ? [] : await deps.listPublicImps();

    const present = await deps.dns.listA(domain, publicOwner);

    for (const name of wanted) {
      const fqdn = `${name}.${domain}`;

      if (ip !== null && present.get(fqdn) !== ip) {
        await deps.dns.setA(fqdn, ip, publicOwner);

        log(`impd: https: ${fqdn} points at ${ip} (public)`);
      }
    }

    for (const fqdn of present.keys()) {
      const label = fqdn.slice(0, -(domain.length + 1));

      // a deeper name is no imp's, whatever its comment says
      if (label.includes('.') || wanted.includes(label)) {
        continue;
      }

      await deps.dns.removeA(fqdn, publicOwner);

      log(`impd: https: removed ${fqdn} (no longer public)`);
    }
  };

  // one pass at a time, so two never race on a record
  const recordsGate = createSemaphore(1);
  let recordsStatus: RecordsStatus | null = null;

  const updatePublicRecords = (): Promise<RecordsStatus> =>
    recordsGate.run(async () => {
      try {
        await applyPublicRecords();

        recordsStatus = { isOk: true, error: null, at: deps.now() };
      } catch (error) {
        const message = readErrorMessage(error);

        log(`impd: https: public records: ${message}`);

        recordsStatus = { isOk: false, error: message, at: deps.now() };
      }

      return recordsStatus;
    });

  return {
    updatePublicRecords,
    readRecordsStatus: () => recordsStatus,
    readPorts: () => ({
      tailnet: listeners.readPorts(),
      public: publicListeners?.readPorts() ?? null,
    }),
    start: () => {
      const certificate = certs.load();

      if (certificate !== null) {
        setCertificate(certificate);
      }

      publicListeners?.setAddresses([deps.publicAddress ?? '0.0.0.0']);

      if (deps.readTailscale === null) {
        log(
          `impd: https: no tailnet; https://<imp>.${domain} answers only inside the host container`,
        );
      }

      // the first pass now, not a tick from now
      void runLogged('addresses', updateAddresses, log);
      void runLogged('renewal', runRenewal, log);
      void updatePublicRecords();

      tickers.push(
        startTask('https renewal', RENEW_INTERVAL_MS, runRenewal, log),

        // as often as renewal: a record changed by hand comes back in time
        startTask(
          'https public records',
          RENEW_INTERVAL_MS,
          async () => {
            await updatePublicRecords();
          },
          log,
        ),
        startTask('https addresses', ADDRESS_INTERVAL_MS, updateAddresses, log),
      );
    },
    stop: async () => {
      state.stopped = true;

      await Promise.all(tickers.map((ticker) => ticker.stop()));
      await listeners.stop();
      await publicListeners?.stop();
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
