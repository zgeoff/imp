import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { ScopeSchema } from '@impz/api';
import type { Scope } from '@impz/api';
import type { Caller } from '../auth/caller';
import type { ImpDatabase } from '../db/open-database';
import type { Approval, SignIns } from './create-sign-ins';
import { formatApprovalCode } from './create-sign-ins';
import { deriveTokenHash } from './derive-token-hash';
import { formatScopeList, pickGrantScope } from './grant-limits';
import {
  buildPageHeaders,
  renderAllowPage,
  renderErrorPage,
  renderPendingPage,
} from './oauth-pages';
import type { SignInErrorPage } from './oauth-pages';
import { readBodyText } from './read-body-text';

// The public route's OAuth paths (docs/guides/mcp.md#public-route): better-auth
// runs the protocol, and impd serves the two pages it sends a browser to,
// /login for the approval code and /consent for what the approval gave.

const MINUTE_MS = 60_000;

// a signed-in approval waits this long for its consent
const CONSENT_MS = 10 * MINUTE_MS;

// a form a page or a client posts; any of them is a few hundred bytes
const MAX_FORM_BYTES = 16 * 1024;

// the paths that serve the protected resource metadata for `<origin>/mcp`
const RESOURCE_METADATA_PATHS: ReadonlySet<string> = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
]);

// what better-auth needs of the instance, as create-mcp-auth.ts wraps it
export interface AuthServer {
  readonly handler: (request: Request) => Promise<Response>;

  // makes the approval's user and session, and resumes the authorization
  readonly signIn: (oauthQuery: string, approval: Readonly<Approval>) => Promise<Response>;
  readonly findSessionID: (cookie: string) => Promise<string | null>;
  readonly readSecret: () => Promise<string>;
  readonly readSessionCookie: () => Promise<{ readonly name: string; readonly secure: boolean }>;
}

interface OAuthRouterDeps {
  readonly auth: AuthServer;
  readonly db: ImpDatabase;
  readonly signIns: SignIns;
  readonly origin: string;
  readonly resource: string;

  // false while the route is off: every path then answers null
  readonly isOn: boolean;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly readApprover: (
    tokenID: string,
    scope: Scope,
    imps: readonly string[] | null,
  ) => Caller | null;
  readonly removeGrantRows: (ids: readonly string[], why: string) => Promise<void>;
}

// one approval between its sign-in and its consent
interface SignedIn {
  readonly binding: string;
  readonly approval: Approval;
  readonly clientName: string;
  readonly expiresAt: number;
}

export function makeOAuthRouter(
  deps: Readonly<OAuthRouterDeps>,
): (request: Request) => Promise<Response | null> {
  const host = new URL(deps.origin).host;

  // by session id: what each signed-in approval may consent to
  const signedIn = new Map<string, SignedIn>();

  const findSignedIn = (sessionID: string): SignedIn | null => {
    const entry = signedIn.get(sessionID);

    if (entry === undefined || entry.expiresAt <= deps.now()) {
      signedIn.delete(sessionID);

      return null;
    }

    return entry;
  };

  // an approval whose consent never came goes once its time is up, though
  // its session, and with it any lookup, may be gone first
  const removeExpiredSignedIn = (): void => {
    const now = deps.now();

    for (const [sessionID, entry] of signedIn) {
      if (entry.expiresAt <= now) {
        signedIn.delete(sessionID);
      }
    }
  };

  const toPublicRequest = (request: Request, url: URL): Request =>
    new Request(`${deps.origin}${url.pathname}${url.search}`, request);

  // the request again for better-auth, with the body it read
  const toPublicFormRequest = (request: Request, url: URL, body: string): Request =>
    new Request(`${deps.origin}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body,
    });

  // The metadata advertises only what imp's clients can use: public clients
  // with no client authentication, no introspection, and Bearer tokens
  // alone, so nothing about DPoP.
  const readMetadata = async (request: Request, url: URL): Promise<Response> => {
    const response = await deps.auth.handler(toPublicRequest(request, url));
    const metadata: unknown = await response.json();

    if (typeof metadata !== 'object' || metadata === null) {
      return new Response(null, { status: 503 });
    }

    const advertised = Object.fromEntries(
      Object.entries(metadata).filter(
        ([key]) => !key.startsWith('introspection_') && !key.startsWith('dpop_'),
      ),
    );

    const headers = { 'cache-control': 'no-store' };

    if (RESOURCE_METADATA_PATHS.has(url.pathname)) {
      return Response.json(
        { ...advertised, resource_name: 'imp' },
        { status: response.status, headers },
      );
    }

    return Response.json(
      {
        ...advertised,
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
      },
      { headers },
    );
  };

  // A fresh login and consent each time, each scope with the lower ones it
  // holds and offline_access, so an approval may give less than asked, and
  // the one resource when the client named none
  const runAuthorize = async (url: URL): Promise<Response> => {
    const params = new URLSearchParams(url.searchParams);

    const asked = (params.get('scope') ?? '').split(' ').filter((word) => word !== '');
    const askedOrRead = asked.length === 0 ? ['read'] : asked;
    const scopes = expandScopes(askedOrRead);

    params.set('prompt', 'login consent');
    params.set('scope', [...scopes, 'offline_access'].join(' '));

    if (!params.has('resource')) {
      params.set('resource', deps.resource);
    }

    const response = await deps.auth.handler(
      new Request(`${deps.origin}/oauth2/authorize?${params.toString()}`, {
        headers: { accept: 'text/html' },
      }),
    );

    const location = response.headers.get('location');
    const target = location === null ? null : new URL(location, deps.origin);

    if (target === null || target.origin !== deps.origin || target.pathname !== '/login') {
      return response;
    }

    const clientID = target.searchParams.get('client_id') ?? '';

    const clientName = await findClientName(deps.db, clientID);

    const started = deps.signIns.start({
      key: target.search.slice(1),
      clientID,
      clientName,
      redirectURI: target.searchParams.get('redirect_uri') ?? '',
      requestedScope: pickGrantScope(scopes),
    });

    if (started.kind === 'too-many') {
      const headers = buildPageHeaders(null);

      headers.set('retry-after', String(started.retryS));

      return new Response(renderErrorPage('too_many'), { status: 429, headers });
    }

    deps.log(`impd: oauth: ${clientName} asks to sign in; it waits for impz oauth approve`);

    return response;
  };

  // The login page, for a sign-in better-auth sent here. Continue, once the
  // sign-in is approved, makes its user and carries the authorization on to
  // consent; deny returns to the client.
  const runLogin = async (request: Request, url: URL): Promise<Response> => {
    const form = request.method === 'POST' ? await readForm(request) : null;

    const oauthQuery =
      request.method === 'GET' ? url.search.slice(1) : (form?.get('oauth_query') ?? '');

    const entry = deps.signIns.find(oauthQuery);

    if (entry === null) {
      return buildErrorPage('expired');
    }

    const buildPendingResponse = (): Response =>
      new Response(
        renderPendingPage(
          {
            oauthQuery,
            clientName: entry.clientName,
            redirectURI: entry.redirectURI,
            requestedScope: entry.requestedScope,
            approvalCode: formatApprovalCode(entry.approvalCode),
          },
          host,
        ),
        { status: 200, headers: buildPageHeaders(new URL(entry.redirectURI).origin) },
      );

    const action = form?.get('action');

    if (request.method === 'GET' || (action === 'continue' && entry.approval === null)) {
      return buildPendingResponse();
    }

    if (action === 'deny') {
      deps.signIns.remove(oauthQuery);

      return buildDenial(oauthQuery);
    }

    const approval = entry.approval;

    if (action !== 'continue' || approval === null) {
      return buildErrorPage('bad_request');
    }

    // spent here, so one approval signs in once
    deps.signIns.remove(oauthQuery);

    if (deps.readApprover(approval.tokenID, approval.scope, approval.imps) === null) {
      return buildErrorPage('approver_gone');
    }

    const signedInResponse = await deps.auth.signIn(oauthQuery, approval);
    const resumed: unknown = await signedInResponse.json();

    const next = readURLField(resumed);
    const setCookies = signedInResponse.headers.getSetCookie();
    const cookie = setCookies.map((line) => line.split(';')[0]).join('; ');

    const sessionID = await deps.auth.findSessionID(cookie);

    if (!signedInResponse.ok || next === null || sessionID === null) {
      deps.log(`impd: oauth: a sign-in for ${entry.clientName} could not reach consent`);

      return buildErrorPage('expired');
    }

    removeExpiredSignedIn();

    signedIn.set(sessionID, {
      binding: buildConsentBinding(oauthQuery),
      approval,
      clientName: entry.clientName,
      expiresAt: deps.now() + CONSENT_MS,
    });

    const headers = new Headers({ location: new URL(next, deps.origin).href });

    for (const line of setCookies) {
      headers.append('set-cookie', line);
    }

    return new Response(null, { status: 302, headers });
  };

  // The consent page, for the session a sign-in started and the request it
  // signed in for; either answer returns to the client with the session
  // cookie cleared
  const runConsent = async (request: Request, url: URL): Promise<Response> => {
    const form = request.method === 'POST' ? await readForm(request) : null;

    const oauthQuery =
      request.method === 'GET' ? url.search.slice(1) : (form?.get('oauth_query') ?? '');

    const cookie = request.headers.get('cookie') ?? '';
    const prompt = (new URLSearchParams(oauthQuery).get('prompt') ?? '').split(' ');

    const secret = await deps.auth.readSecret();
    const isSigned = await verifyOAuthQueryParams(oauthQuery, secret);

    const sessionID = cookie === '' ? null : await deps.auth.findSessionID(cookie);
    const entry = sessionID === null ? null : findSignedIn(sessionID);

    if (
      !isSigned ||
      prompt.includes('login') ||
      sessionID === null ||
      entry === null ||
      entry.binding !== buildConsentBinding(oauthQuery)
    ) {
      return buildErrorPage('expired');
    }

    const params = new URLSearchParams(oauthQuery);

    const redirectURI = params.get('redirect_uri') ?? '';

    if (request.method === 'GET') {
      return new Response(
        renderAllowPage({
          oauthQuery,
          clientName: entry.clientName,
          redirectURI,
          scope: entry.approval.scope,
          imps: entry.approval.imps,
        }),
        { status: 200, headers: buildPageHeaders(new URL(redirectURI).origin) },
      );
    }

    const action = form?.get('action');

    if (action !== 'allow' && action !== 'deny') {
      return buildErrorPage('bad_request');
    }

    // one sign-in answers one consent
    signedIn.delete(sessionID);

    const accept = action === 'allow';
    const scope = `${formatScopeList(entry.approval.scope)} offline_access`;

    const choice = JSON.stringify({
      accept,
      ...(accept && { scope }),
      oauth_query: oauthQuery,
    });

    const consented = await deps.auth.handler(
      new Request(`${deps.origin}/oauth2/consent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          origin: deps.origin,
          cookie,
        },
        body: choice,
      }),
    );

    const answer: unknown = await consented.json();

    const next = readURLField(answer);
    const isIssued = consented.ok && next !== null && new URL(next).searchParams.has('code');

    // an issued code needs the session for its exchange, which removes it;
    // otherwise the session goes now
    await (isIssued
      ? deps.db
          .updateTable('session')
          .set({ expiresAt: new Date(Date.now() + CONSENT_MS).toISOString() })
          .where('id', '=', sessionID)
          .execute()
      : deps.db.deleteFrom('session').where('id', '=', sessionID).execute());

    if (!consented.ok || next === null) {
      return buildErrorPage('expired');
    }

    if (isIssued) {
      deps.log(
        `impd: oauth: ${entry.clientName} signed in, approved by token ${entry.approval.tokenName}`,
      );
    }

    const sessionCookie = await deps.auth.readSessionCookie();

    const secure = sessionCookie.secure ? '; Secure' : '';

    return new Response(null, {
      status: 302,
      headers: {
        location: next,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'set-cookie': `${sessionCookie.name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`,
      },
    });
  };

  // A code exchange binds its tokens to the session that approved them;
  // once issued, no token needs it, so every session a token holds goes,
  // with the expired ones.
  const runTokenRequest = async (request: Request, url: URL): Promise<Response> => {
    const body = await readBodyText(request, MAX_FORM_BYTES);

    if (body === null) {
      return buildBadTokenRequest();
    }

    const response = await deps.auth.handler(toPublicFormRequest(request, url, body));

    if (response.ok) {
      const held = await deps.db
        .selectFrom('oauthAccessToken')
        .select('sessionId')
        .where('sessionId', 'is not', null)
        .union(
          deps.db
            .selectFrom('oauthRefreshToken')
            .select('sessionId')
            .where('sessionId', 'is not', null),
        )
        .execute();

      const sessionIDs = held.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId]));

      await deps.db
        .deleteFrom('session')
        .where((eb) =>
          eb.or([
            eb('expiresAt', '<', new Date().toISOString()),
            ...(sessionIDs.length === 0 ? [] : [eb('id', 'in', sessionIDs)]),
          ]),
        )
        .execute();
    }

    return response;
  };

  // RFC 7009 through better-auth; a token it revoked for its own client
  // takes its whole grant with it, as imp's grants always went
  const runRevoke = async (request: Request, url: URL): Promise<Response> => {
    const body = await readBodyText(request, MAX_FORM_BYTES);

    if (body === null) {
      return buildBadTokenRequest();
    }

    const form = new URLSearchParams(body);

    const hash = deriveTokenHash(form.get('token') ?? '');

    const owner = await deps.db
      .selectFrom('oauthAccessToken')
      .select(['userId', 'clientId'])
      .where('token', '=', hash)
      .union(
        deps.db
          .selectFrom('oauthRefreshToken')
          .select(['userId', 'clientId'])
          .where('token', '=', hash),
      )
      .executeTakeFirst();

    const response = await deps.auth.handler(toPublicFormRequest(request, url, body));

    // RFC 7009: a token the server does not know is answered as revoked
    if (owner === undefined && response.status === 400) {
      const refusal: unknown = await response.clone().json();

      if (readErrorDescription(refusal) === 'token not found') {
        return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
      }
    }

    if (
      response.ok &&
      owner !== undefined &&
      owner.userId !== null &&
      owner.clientId === form.get('client_id')
    ) {
      await deps.removeGrantRows([owner.userId], 'its client revoked it');
    }

    return response;
  };

  // a denial back to the client's redirect URI, with the issuer (RFC 9207);
  // the query is one better-auth signed, so its redirect URI is the client's
  const buildDenial = (oauthQuery: string): Response => {
    const params = new URLSearchParams(oauthQuery);
    const target = new URL(params.get('redirect_uri') ?? '');

    const state = params.get('state');

    target.searchParams.set('error', 'access_denied');
    target.searchParams.set('error_description', 'the sign-in was denied');

    if (state !== null) {
      target.searchParams.set('state', state);
    }

    target.searchParams.set('iss', deps.origin);

    return new Response(null, {
      status: 302,
      headers: {
        location: target.href,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    });
  };

  return (request) => {
    if (!deps.isOn) {
      return Promise.resolve(null);
    }

    const url = new URL(request.url);

    const route = `${request.method} ${url.pathname}`;

    if (
      route === 'GET /.well-known/oauth-authorization-server' ||
      (request.method === 'GET' && RESOURCE_METADATA_PATHS.has(url.pathname))
    ) {
      return readMetadata(request, url);
    }

    // where better-auth sends a refusal it cannot return to the client
    if (route === 'GET /error') {
      const isUnknownClient = url.searchParams.get('error') === 'invalid_client';
      const page = isUnknownClient ? 'unknown_client' : 'bad_request';

      return Promise.resolve(buildErrorPage(page));
    }

    if (route === 'GET /oauth2/authorize') {
      return runAuthorize(url);
    }

    if (route === 'POST /oauth2/token') {
      return runTokenRequest(request, url);
    }

    if (route === 'POST /oauth2/revoke') {
      return runRevoke(request, url);
    }

    const isPage = url.pathname === '/login' || url.pathname === '/consent';

    if (!isPage || (request.method !== 'GET' && request.method !== 'POST')) {
      return Promise.resolve(null);
    }

    if (request.method === 'POST' && !isSameOriginForm(request, deps.origin)) {
      return Promise.resolve(buildErrorPage('bad_request'));
    }

    return url.pathname === '/login' ? runLogin(request, url) : runConsent(request, url);
  };
}

// imp's scopes, lowest first, as words a request may hold
const SCOPE_ORDER: readonly string[] = ScopeSchema.options;

// each of imp's scopes with the lower ones it holds; any other word stays,
// for better-auth to refuse
function expandScopes(asked: readonly string[]): string[] {
  const expanded = asked.flatMap((word) => {
    const index = SCOPE_ORDER.indexOf(word);

    return index === -1 ? [word] : SCOPE_ORDER.slice(0, index + 1);
  });

  return [...new Set(expanded)];
}

// The parts of an authorization request that stay the same from its login
// page to its consent page. better-auth signs each page's query afresh, so
// a sign-in binds to its consent through these.
function buildConsentBinding(oauthQuery: string): string {
  const params = new URLSearchParams(oauthQuery);

  return JSON.stringify(
    ['client_id', 'redirect_uri', 'scope', 'resource', 'state', 'code_challenge'].map(
      (name) => params.get(name) ?? '',
    ),
  );
}

async function findClientName(db: ImpDatabase, clientID: string): Promise<string> {
  const row = await db
    .selectFrom('oauthClient')
    .select('name')
    .where('clientId', '=', clientID)
    .executeTakeFirst();

  return row?.name ?? clientID;
}

// better-auth's next URL in a JSON answer, as `url` or `redirect_uri`
function readURLField(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) {
    return null;
  }

  const fields = new Map(Object.entries(answer));

  const next: unknown = fields.get('url') ?? fields.get('redirect_uri');

  return typeof next === 'string' ? next : null;
}

// better-auth's error_description in a JSON refusal, or null
function readErrorDescription(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) {
    return null;
  }

  const description: unknown = new Map(Object.entries(answer)).get('error_description');

  return typeof description === 'string' ? description : null;
}

// a urlencoded form of at most MAX_FORM_BYTES; null for anything else
async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get('content-type') ?? '';

  if (!type.startsWith('application/x-www-form-urlencoded')) {
    return null;
  }

  const text = await readBodyText(request, MAX_FORM_BYTES);

  return text === null ? null : new URLSearchParams(text);
}

// RFC 6749's refusal of a token or revoke request with no body, or one past
// MAX_FORM_BYTES, which better-auth never reads
function buildBadTokenRequest(): Response {
  return Response.json(
    { error: 'invalid_request', error_description: 'the request body is missing or too large' },
    { status: 400, headers: { 'cache-control': 'no-store' } },
  );
}

// A form a page on another origin posts never counts. A browser names the
// page's origin, or sends Origin null with Sec-Fetch-Site, which it sets
// itself and no page can change.
function isSameOriginForm(request: Request, origin: string): boolean {
  const from = request.headers.get('origin');

  if (from === origin) {
    return true;
  }

  return from === 'null' && request.headers.get('sec-fetch-site') === 'same-origin';
}

function buildErrorPage(error: SignInErrorPage): Response {
  return new Response(renderErrorPage(error), { status: 400, headers: buildPageHeaders(null) });
}
