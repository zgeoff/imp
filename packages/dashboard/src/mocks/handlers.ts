import { isSameOrigin } from '@imp/daemon/src/auth/authenticate';
import { RPCHandler } from '@orpc/server/fetch';
import { HttpResponse, http } from 'msw';
import * as z from 'zod';
import { sessionCollection } from './db/session-collection';
import { readTokenId, tokenCollection } from './db/token-collection';
import { impdLogouts } from './impd-events';
import { impdRouter } from './impd-router';
import type { ImpdSession } from './impd-router';

// the impd that serves the dashboard in the tests (test-setup.ts sets the
// page's URL under it)
export const IMPD_ORIGIN = 'http://impd.test';
export const LOGIN_URL = `${IMPD_ORIGIN}/auth/login`;
export const LOGOUT_URL = `${IMPD_ORIGIN}/auth/logout`;
export const RPC_URL = `${IMPD_ORIGIN}/rpc`;

interface RouteContext {
  readonly request: Request;
}

const LoginSchema = z.object({ token: z.string() });

const rpc = new RPCHandler(impdRouter);

function readJson(request: Readonly<Request>): Promise<unknown> {
  return request.json().then(
    (json: unknown) => json,
    () => null,
  );
}

// a known token's secret opens a session with that token's scope; any other
// body, malformed JSON included, gets a 401
async function resolveLoginBody(json: unknown): Promise<Response> {
  const body = LoginSchema.safeParse(json);

  const token = body.success
    ? tokenCollection.findFirst((query) => query.where({ secret: body.data.token }))
    : undefined;

  if (token === undefined) {
    return HttpResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  sessionCollection.clear();

  await sessionCollection.create({ tokenId: readTokenId(token.secret) });

  return new HttpResponse(null, { status: 204 });
}

export function resolveLogin(context: RouteContext): Promise<Response> {
  if (!isSameOrigin(context.request)) {
    return Promise.resolve(HttpResponse.json({ error: 'cross-origin' }, { status: 403 }));
  }

  return readJson(context.request).then((json) => resolveLoginBody(json));
}

export function resolveLogout(context: RouteContext): Response {
  if (!isSameOrigin(context.request)) {
    return HttpResponse.json({ error: 'cross-origin' }, { status: 403 });
  }

  sessionCollection.clear();
  impdLogouts.logOut();

  return new HttpResponse(null, { status: 204 });
}

// impd's readSessionCaller (packages/daemon auth/authenticate.ts): the
// session, same-origin and unexpired, as its token is now, found by id, so
// a new token under the old name does not revive it
function readSession(request: Request): ImpdSession | null {
  const session = isSameOrigin(request) ? sessionCollection.findFirst() : undefined;

  if (session === undefined || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  const token = tokenCollection
    .findMany()
    .find((row) => readTokenId(row.secret) === session.tokenId);

  if (token === undefined) {
    return null;
  }

  return {
    kind: 'dashboard',
    name: token.name,
    scope: token.scope,
    imps: token.imps,
    grantable: token.grantable,
    expiresAt: session.expiresAt,
  };
}

// impd's /rpc (packages/daemon build-app.ts): the browser's session, only
// from impd's own origin and before it expires, or impd's 401; oRPC's own
// fetch handler answers through impdRouter
export async function resolveRpc(context: RouteContext): Promise<Response> {
  const session = readSession(context.request);

  if (session === null) {
    return HttpResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const handled = await rpc.handle(context.request, { prefix: '/rpc', context: { session } });

  return handled.matched ? handled.response : new Response('not found', { status: 404 });
}

export const handlers = [
  http.post(LOGIN_URL, resolveLogin),
  http.post(LOGOUT_URL, resolveLogout),
  http.all(`${RPC_URL}/*`, resolveRpc),
];
