import { faker } from '@faker-js/faker';
import { Collection } from '@msw/data';
import { HttpResponse, http } from 'msw';
import * as z from 'zod';

// the impd that serves the dashboard in the tests (test-setup.ts sets the
// page's URL under it)
export const IMPD_ORIGIN = 'http://impd.test';
export const LOGIN_URL = `${IMPD_ORIGIN}/auth/login`;
export const LOGOUT_URL = `${IMPD_ORIGIN}/auth/logout`;

// the API tokens impd knows, which /auth/login accepts; the preload clears it
// after each test
export const knownTokens = new Collection({
  schema: z.object({ token: z.string().default(() => faker.string.alphanumeric(32)) }),
});

interface SessionRouteContext {
  readonly request: Request;
}

const LoginSchema = z.object({ token: z.string() });

// impd's isSameOrigin (packages/daemon auth/authenticate.ts): Sec-Fetch-Site
// decides when sent, else an Origin with impd's host; neither is refused
function isSameOrigin(request: Readonly<Request>): boolean {
  const site = request.headers.get('sec-fetch-site');

  if (site !== null) {
    return site === 'same-origin';
  }

  const origin = request.headers.get('origin');

  if (origin === null) {
    return false;
  }

  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function readJson(request: Readonly<Request>): Promise<unknown> {
  return request.json().then(
    (json: unknown) => json,
    () => null,
  );
}

// a known token gets a session; any other body, malformed JSON included, a 401
function resolveLoginBody(json: unknown): Response {
  const body = LoginSchema.safeParse(json);

  const known =
    body.success && knownTokens.findFirst((query) => query.where({ token: body.data.token }));

  if (known === false || known === undefined) {
    return HttpResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  return new HttpResponse(null, { status: 204 });
}

export function resolveLogin(context: SessionRouteContext): Promise<Response> {
  if (!isSameOrigin(context.request)) {
    return Promise.resolve(HttpResponse.json({ error: 'cross-origin' }, { status: 403 }));
  }

  return readJson(context.request).then((json) => resolveLoginBody(json));
}

export function resolveLogout(context: SessionRouteContext): Response {
  if (!isSameOrigin(context.request)) {
    return HttpResponse.json({ error: 'cross-origin' }, { status: 403 });
  }

  return new HttpResponse(null, { status: 204 });
}

export const handlers = [http.post(LOGIN_URL, resolveLogin), http.post(LOGOUT_URL, resolveLogout)];
