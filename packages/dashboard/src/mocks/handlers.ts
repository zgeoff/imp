import { HttpResponse, http } from 'msw';

// the impd that serves the dashboard in the tests (test-setup.ts sets the
// page's URL under it)
export const IMPD_ORIGIN = 'http://impd.test';

// the tokens /auth/login accepts; the preload clears it after each test
export const knownTokens = new Set<string>();

interface LoginContext {
  readonly request: Request;
}

// impd's session routes (packages/daemon auth/session-routes.ts): a known
// token gets a session, any other a 401
export async function resolveLogin(context: LoginContext): Promise<Response> {
  const body: unknown = await context.request.json();

  const token = typeof body === 'object' && body !== null && 'token' in body ? body.token : null;

  if (typeof token === 'string' && knownTokens.has(token)) {
    return new HttpResponse(null, { status: 204 });
  }

  return HttpResponse.json({ error: 'unauthorized' }, { status: 401 });
}

function resolveLogout(): Response {
  return new HttpResponse(null, { status: 204 });
}

export const handlers = [
  http.post(`${IMPD_ORIGIN}/auth/login`, resolveLogin),
  http.post(`${IMPD_ORIGIN}/auth/logout`, resolveLogout),
];
