import { createHash, randomBytes } from 'node:crypto';
import * as z from 'zod';
import { tryImp } from './imp-cli';
import type { DevInstance } from './instance';

// A client of impd's public MCP route (docs/guides/mcp.md#public-route): the
// login and consent pages, the CLI's approval, the token endpoint, and /mcp.

export const RouteTokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  scope: z.string(),
});

export type RouteTokens = z.infer<typeof RouteTokensSchema>;

// The route's origin on the instance: impd's :7071, published at the
// instance's offset; plain http on loopback, as tests alone may use.
export function buildRouteOrigin(target: Readonly<Pick<DevInstance, 'portOffset'>>): string {
  return `http://127.0.0.1:${String(7071 + target.portOffset)}`;
}

// RFC 7636's S256: the verifier's SHA-256, base64url
export function buildPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface ApprovalPage {
  // what `impz oauth approve` takes
  readonly code: string;

  // the signed query the form posts back
  readonly oauthQuery: string;
}

// the login page's approval code and form field, '' for each it lacks
export function parseApprovalPage(page: string): ApprovalPage {
  const query = /name="oauth_query" value="(?<query>[^"]+)"/v.exec(page)?.groups?.['query'] ?? '';

  return {
    code: /impz oauth approve (?<code>[A-Z0-9\-]+)/v.exec(page)?.groups?.['code'] ?? '',
    oauthQuery: query.replaceAll('&amp;', '&'),
  };
}

// An answer from /mcp: the last SSE event's data, or the body, parsed as
// JSON, or the text of one that is not JSON, such as a 401's.
export function parseMcpBody(text: string): unknown {
  const events = text.split('\n').filter((line) => line.startsWith('data: '));
  const last = events.at(-1)?.slice('data: '.length) ?? text;

  try {
    const parsed: unknown = JSON.parse(last);

    return parsed;
  } catch {
    return last;
  }
}

// the cookies a response sets, as a request sends them back
export function readCookies(response: Readonly<Pick<Response, 'headers'>>): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
}

// Thin glue over the live route below.

// as a browser posts a page's form under a same-origin referrer policy:
// Origin null, and Sec-Fetch-Site it sets itself
export const BROWSER_FORM = { origin: 'null', 'sec-fetch-site': 'same-origin' };

export function sendForm(
  url: string,
  fields: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

export interface McpAnswer {
  readonly status: number;
  readonly session: string;
  readonly body: unknown;
}

// a JSON-RPC call on the route's /mcp, in the session when one is given
export async function sendMcp(
  origin: string,
  bearer: string,
  session: string,
  method: string,
  params: unknown = {},
): Promise<McpAnswer> {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session !== '' && { 'mcp-session-id': session }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  const text = await response.text();

  return {
    status: response.status,
    session: response.headers.get('mcp-session-id') ?? '',
    body: parseMcpBody(text),
  };
}

// an MCP session on the route; throws unless initialize answers 200
export async function openRouteMcp(origin: string, bearer: string): Promise<string> {
  const opened = await sendMcp(origin, bearer, '', 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '1.0.0' },
  });

  if (opened.status !== 200) {
    throw new Error(`initialize answered ${String(opened.status)}: ${JSON.stringify(opened.body)}`);
  }

  return opened.session;
}

export interface Approval {
  // the named token that approves, with the scope it grants
  readonly approverToken: string;
  readonly scope: string;
}

// The browser's part of a sign-in, as arrangement: authorization, the login
// page, the CLI's approval, Continue and Allow, to the redirect back with its
// code. Each step that goes another way throws, naming it.
export async function runBrowserSignIn(
  authorizationURL: string,
  approval: Readonly<Approval>,
): Promise<URL> {
  const origin = new URL(authorizationURL).origin;

  const authorized = await fetch(authorizationURL, { redirect: 'manual' });

  const loginURL = new URL(authorized.headers.get('location') ?? '/', origin);

  if (loginURL.pathname !== '/login') {
    throw new Error(`authorize answered ${String(authorized.status)} to ${loginURL.href}`);
  }

  const login = await fetch(loginURL);
  const loginPage = await login.text();

  const page = parseApprovalPage(loginPage);

  const approved = await tryImp(
    ['oauth', 'approve', page.code, '--scope', approval.scope, '--yes'],
    { token: approval.approverToken },
  );

  if (approved.exitCode !== 0) {
    throw new Error(`impz oauth approve: ${approved.stderr}`);
  }

  const continued = await sendForm(
    `${origin}/login`,
    { oauth_query: page.oauthQuery, action: 'continue' },
    BROWSER_FORM,
  );

  const consentURL = new URL(continued.headers.get('location') ?? '/', origin);

  if (consentURL.pathname !== '/consent') {
    throw new Error(`Continue answered ${String(continued.status)}, not a redirect to consent`);
  }

  const allowed = await sendForm(
    `${origin}/consent`,
    { oauth_query: consentURL.search.slice(1), action: 'allow' },
    { ...BROWSER_FORM, cookie: readCookies(continued) },
  );

  const back = new URL(allowed.headers.get('location') ?? '/', origin);

  if (!back.searchParams.has('code')) {
    throw new Error(`Allow answered ${String(allowed.status)} with no code: ${back.href}`);
  }

  return back;
}

export interface SignIn extends Approval {
  readonly origin: string;
  readonly clientId: string;
  readonly redirect: string;
}

// A sign-in from authorization to the client's tokens, approved with the
// CLI, as arrangement
export async function runSignIn(signIn: Readonly<SignIn>): Promise<RouteTokens> {
  const verifier = randomBytes(32).toString('base64url');

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: signIn.clientId,
    redirect_uri: signIn.redirect,
    code_challenge: buildPkceChallenge(verifier),
    code_challenge_method: 'S256',
    state: 'e2e',
    scope: 'read exec',
    resource: `${signIn.origin}/mcp`,
  });

  const back = await runBrowserSignIn(
    `${signIn.origin}/oauth2/authorize?${query.toString()}`,
    signIn,
  );

  const exchanged = await sendForm(`${signIn.origin}/oauth2/token`, {
    grant_type: 'authorization_code',
    client_id: signIn.clientId,
    code: back.searchParams.get('code') ?? '',
    redirect_uri: signIn.redirect,
    code_verifier: verifier,
    resource: `${signIn.origin}/mcp`,
  });

  const body: unknown = await exchanged.json();

  return RouteTokensSchema.parse(body);
}
