import * as z from 'zod';
import { isSameOrigin } from './authenticate';
import {
  SESSION_MAX_AGE_S,
  buildClearedSessionCookies,
  buildSessionCookie,
  buildSessionValue,
} from './session-cookie';
import type { TokenStore } from './token-store';

const LoginSchema = z.object({ token: z.string() });

export interface SessionRouteDeps {
  readonly tokens: TokenStore;
  readonly rootToken: string;
  readonly now: () => number;

  // after a logout: the dashboard's event streams end
  readonly onLogout?: () => void;
}

// POST /auth/login with {"token": "…"} sets a session cookie with that
// token's scope; POST /auth/logout clears it. Both only from impd's own
// origin, so no other page logs a browser in with its token, or out.
export function createSessionRoutes(deps: Readonly<SessionRouteDeps>) {
  return {
    login: async (request: Request): Promise<Response> => {
      if (!isSameOrigin(request)) {
        return Response.json({ error: 'cross-origin' }, { status: 403 });
      }

      const json = await readJson(request);

      const body = LoginSchema.safeParse(json);
      const caller = body.success ? deps.tokens.authenticate(body.data.token) : null;

      if (caller?.tokenId === undefined || caller.tokenId === null) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }

      const value = buildSessionValue(deps.rootToken, {
        tokenId: caller.tokenId,
        expiresAt: deps.now() + SESSION_MAX_AGE_S * 1000,
      });

      return new Response(null, {
        status: 204,
        headers: { 'set-cookie': buildSessionCookie(value, isSecure(request)) },
      });
    },
    logout: (request: Request): Response => {
      if (!isSameOrigin(request)) {
        return Response.json({ error: 'cross-origin' }, { status: 403 });
      }

      const headers = new Headers();

      for (const cookie of buildClearedSessionCookies(isSecure(request))) {
        headers.append('set-cookie', cookie);
      }

      deps.onLogout?.();

      return new Response(null, { status: 204, headers });
    },
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// A TLS front such as tailscale serve says so in x-forwarded-proto. Any
// client can send that header, so it only adds Secure to the cookie and must
// never decide what a request may do.
function isSecure(request: Request): boolean {
  return (
    new URL(request.url).protocol === 'https:' ||
    request.headers.get('x-forwarded-proto') === 'https'
  );
}
