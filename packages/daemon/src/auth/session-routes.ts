import * as z from 'zod';
import { isAuthorized } from '../token';
import { isSameOrigin } from './authenticate';
import {
  SESSION_MAX_AGE_S,
  buildClearedSessionCookie,
  buildSessionCookie,
  buildSessionValue,
} from './session-cookie';

const LoginSchema = z.object({ token: z.string() });

export interface SessionRouteDeps {
  readonly token: string;
  readonly now: () => number;
}

// POST /auth/login with {"token": "…"} sets the session cookie; POST
// /auth/logout clears it. Both only from impd's own origin, so another page
// cannot log a browser in with a token of its choosing, or out.
export function createSessionRoutes(deps: Readonly<SessionRouteDeps>) {
  return {
    login: async (request: Request): Promise<Response> => {
      if (!isSameOrigin(request)) {
        return Response.json({ error: 'cross-origin' }, { status: 403 });
      }

      const json = await readJson(request);

      const body = LoginSchema.safeParse(json);

      if (!body.success || !isAuthorized(`Bearer ${body.data.token}`, deps.token)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }

      const value = buildSessionValue(deps.token, deps.now() + SESSION_MAX_AGE_S * 1000);

      return new Response(null, {
        status: 204,
        headers: { 'set-cookie': buildSessionCookie(value, isSecure(request)) },
      });
    },
    logout: (request: Request): Response => {
      if (!isSameOrigin(request)) {
        return Response.json({ error: 'cross-origin' }, { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: { 'set-cookie': buildClearedSessionCookie(isSecure(request)) },
      });
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
