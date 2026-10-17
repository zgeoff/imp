// A sign-in started on the public MCP route, as a browser starts one: the
// client's authorize request, then the login page better-auth sends it to.
// Throws, naming the step, when either goes another way.

// RFC 7636's example verifier and its S256 challenge
export const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

export interface SignInRoute {
  // the route's handler, as the listener calls it
  readonly handle: (request: Request) => Promise<Response>;
  readonly origin: string;
  readonly clientID: string;
  readonly redirectURI: string;

  // as the client asks for it, such as `read exec`
  readonly scope: string;
}

interface PendingSignIn {
  // what `impz oauth approve` takes, as the page shows it
  readonly code: string;

  // the signed query the login page's form posts back
  readonly oauthQuery: string;
}

export async function createPendingSignIn(route: Readonly<SignInRoute>): Promise<PendingSignIn> {
  const host = new URL(route.origin).host;

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: route.clientID,
    redirect_uri: route.redirectURI,
    code_challenge: PKCE_CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st',
    scope: route.scope,
    resource: `${route.origin}/mcp`,
  });

  const authorized = await route.handle(
    new Request(`${route.origin}/oauth2/authorize?${query.toString()}`, { headers: { host } }),
  );

  const location = authorized.headers.get('location') ?? '';

  const login = new URL(location, route.origin);

  if (login.pathname !== '/login') {
    throw new Error(`authorize answered ${String(authorized.status)} to ${location}`);
  }

  const page = await route.handle(new Request(login.href, { headers: { host } }));
  const text = await page.text();

  const code = /impz oauth approve (?<code>[A-Z0-9\-]+)/v.exec(text)?.groups?.['code'];

  if (code === undefined) {
    throw new Error(`the login page answered ${String(page.status)} with no approval code`);
  }

  return { code, oauthQuery: login.search.slice(1) };
}
