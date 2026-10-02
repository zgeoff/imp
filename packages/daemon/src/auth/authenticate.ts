import { isAllowedAmbientRequest } from './ambient-request';
import type { KnownHosts } from './ambient-request';
import type { Caller } from './caller';
import { readSession, readSessionCookies } from './session-cookie';
import type { TailnetIdentities } from './tailnet-identity';
import { readBearer } from './token-store';
import type { TokenStore } from './token-store';

export interface CallerSources {
  readonly tokens: TokenStore;
  readonly rootToken: string;
  readonly now: () => number;

  // null when no rule gives tailnet peers access
  readonly tailnet: {
    readonly identities: TailnetIdentities;
    readonly knownHosts: KnownHosts;
  } | null;
}

export interface CallerOptions {
  // the connection's peer address: the socket's, or the client's as the
  // wake proxy handed it over in-process; null when unknown
  readonly peer: string | null;

  // the dashboard's session cookie counts; /exec and /tunnel take tickets
  // and tokens only
  readonly cookie: boolean;
}

// Who a request runs as: its bearer token, the dashboard's session cookie,
// or its peer's tailnet identity, for every route alike. Null for none, and
// for a wrong bearer token, which never falls through to another source.
export async function resolveCaller(
  request: Request,
  sources: Readonly<CallerSources>,
  options: Readonly<CallerOptions>,
): Promise<Caller | null> {
  const bearer = readBearer(request.headers.get('authorization'));

  if (bearer !== null) {
    return sources.tokens.authenticate(bearer);
  }

  if (options.cookie && isSameOrigin(request)) {
    const session = readSessionCaller(request, sources);

    if (session !== null) {
      return session;
    }
  }

  if (sources.tailnet === null || options.peer === null) {
    return null;
  }

  const hosts = await sources.tailnet.knownHosts.read();

  if (!isAllowedAmbientRequest(request, hosts)) {
    return null;
  }

  return sources.tailnet.identities.resolve(options.peer);
}

// An imp's page can plant its own imp_session on a longer path, which the
// browser sends first, so every session value is tried. A session whose
// token is gone logs nobody in.
function readSessionCaller(request: Request, sources: Readonly<CallerSources>): Caller | null {
  const at = sources.now();

  for (const value of readSessionCookies(request.headers.get('cookie'))) {
    const claim = readSession(value, sources.rootToken, at);
    const caller = claim === null ? null : sources.tokens.findById(claim.tokenId);

    if (claim !== null && caller !== null) {
      return { ...caller, kind: 'dashboard', expiresAt: claim.expiresAt };
    }
  }

  return null;
}

// Imps serve pages on other ports of this host, which SameSite counts as the same site; only a
// same-origin request may use the cookie (docs/architecture/daemon.md#dashboard). No Origin
// at all is a refusal.
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');

  if (site !== null) {
    return site === 'same-origin';
  }

  const origin = request.headers.get('origin');

  if (origin === null) {
    return false;
  }

  // host and port only (Bun builds the request URL from the Host header): a
  // TLS front such as tailscale serve talks plain HTTP to impd, so the scheme
  // the browser saw is not the one impd sees
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
