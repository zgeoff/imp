import type { TailscaleStatus } from '../net/tailscale-status';

// A tailnet identity is ambient, like a cookie: a browser on that machine
// sends it with any page's requests. So such a request must name a host impd
// knows (DNS rebinding) and come from impd's own origin, not an imp's port.

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// how long the tailnet name and address are kept between reads
const STATUS_TTL_MS = 30_000;

export interface KnownHosts {
  readonly read: () => Promise<ReadonlySet<string>>;
}

interface KnownHostsDeps {
  readonly readTailscale: () => Promise<TailscaleStatus>;

  // the apex of IMP_DOMAIN, where impd's API answers; null without one
  readonly domain: string | null;
  readonly now: () => number;
}

// the names impd answers to: loopback, the tailnet node's names and
// address, and the domain
export function createKnownHosts(deps: Readonly<KnownHostsDeps>): KnownHosts {
  const state: { hosts: Promise<ReadonlySet<string>> | null; at: number } = { hosts: null, at: 0 };

  const load = async (): Promise<ReadonlySet<string>> => {
    const status = await deps.readTailscale();

    const names = [...LOOPBACK_HOSTS, status.hostname, status.dnsName, status.ip, deps.domain];

    return new Set(names.filter((name) => name !== null).map((name) => name.toLowerCase()));
  };

  return {
    read: () => {
      const at = deps.now();

      if (state.hosts === null || at - state.at >= STATUS_TTL_MS) {
        state.hosts = load();
        state.at = at;
      }

      return state.hosts;
    },
  };
}

export function isAllowedAmbientRequest(request: Request, hosts: ReadonlySet<string>): boolean {
  const host = readHostName(request.headers.get('host'));

  if (host === null || !hosts.has(host)) {
    return false;
  }

  const site = request.headers.get('sec-fetch-site');

  // `none` is a navigation the user typed
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return false;
  }

  // a client that is not a browser sends no Origin
  const origin = request.headers.get('origin');

  if (origin === null) {
    return true;
  }

  try {
    return new URL(origin).host === request.headers.get('host')?.toLowerCase();
  } catch {
    return false;
  }
}

// the Host header without its port, lowercased; null when there is none
function readHostName(header: string | null): string | null {
  if (header === null || header === '') {
    return null;
  }

  try {
    return new URL(`http://${header}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}
