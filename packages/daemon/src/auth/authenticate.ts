import { isAuthorized } from '../token';
import { readSessionCookies, readSessionExpiry } from './session-cookie';

// who called, and when what they authenticated with expires: never for the
// token, the session's expiry for the dashboard
export type Caller =
  | { readonly actor: 'token'; readonly expiresAt: null }
  | { readonly actor: 'dashboard'; readonly expiresAt: number };

// The bearer token, or the dashboard's session cookie from its own page;
// tailnet identity (#29) slots in here as one more source. Null for neither.
export function readCaller(request: Request, token: string, nowMs: number): Caller | null {
  if (isAuthorized(request.headers.get('authorization'), token)) {
    return { actor: 'token', expiresAt: null };
  }

  if (!isSameOrigin(request)) {
    return null;
  }

  const expiries = readSessionCookies(request.headers.get('cookie')).map((session) =>
    readSessionExpiry(session, token, nowMs),
  );

  const expiresAt = expiries.find((expiry) => expiry !== null);

  return expiresAt === undefined || expiresAt === null ? null : { actor: 'dashboard', expiresAt };
}

// Imps serve pages on other ports of this host, which SameSite counts as the
// same site; only a same-origin request may use the cookie (daemon.md,
// Dashboard). No Origin at all is a refusal.
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
