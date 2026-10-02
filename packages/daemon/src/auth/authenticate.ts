import { isAuthorized } from '../token';
import { isValidSession, readSessionCookie } from './session-cookie';

// The bearer token, or the dashboard's session cookie from its own page;
// tailnet identity (#29) slots in here as one more source
export function isAuthenticated(request: Request, token: string, nowMs: number): boolean {
  if (isAuthorized(request.headers.get('authorization'), token)) {
    return true;
  }

  const session = readSessionCookie(request.headers.get('cookie'));

  return session !== null && isSameOrigin(request) && isValidSession(session, token, nowMs);
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
