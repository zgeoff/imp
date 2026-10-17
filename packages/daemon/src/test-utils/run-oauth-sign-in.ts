import * as z from 'zod';
import { PKCE_VERIFIER, createPendingSignIn } from './create-pending-sign-in';
import type { SignInRoute } from './create-pending-sign-in';

// A whole sign-in on the public MCP route, as arrangement: the login page,
// the approval `approve` makes, Continue, Allow, and the code's exchange.
// Throws, naming the step, when one goes another way.

const TokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  scope: z.string(),
});

type RouteTokens = z.infer<typeof TokensSchema>;

export async function runOAuthSignIn(
  route: Readonly<SignInRoute>,
  approve: (code: string) => void | Promise<void>,
): Promise<RouteTokens> {
  const host = new URL(route.origin).host;

  const pending = await createPendingSignIn(route);

  await approve(pending.code);

  const form = {
    host,
    'content-type': 'application/x-www-form-urlencoded',
    origin: route.origin,
  };

  const continued = await route.handle(
    new Request(`${route.origin}/login`, {
      method: 'POST',
      headers: form,
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'continue' }),
    }),
  );

  const consentURL = new URL(continued.headers.get('location') ?? '/', route.origin);

  const cookie = continued.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  if (consentURL.pathname !== '/consent') {
    throw new Error(`Continue answered ${String(continued.status)}, not a redirect to consent`);
  }

  const consentQuery = consentURL.search.slice(1);

  const allowed = await route.handle(
    new Request(`${route.origin}/consent`, {
      method: 'POST',
      headers: { ...form, cookie },
      body: new URLSearchParams({ oauth_query: consentQuery, action: 'allow' }),
    }),
  );

  const back = new URL(allowed.headers.get('location') ?? route.redirectURI);

  const code = back.searchParams.get('code');

  if (code === null) {
    throw new Error(`Allow answered ${String(allowed.status)} with no code: ${back.href}`);
  }

  const exchanged = await route.handle(
    new Request(`${route.origin}/oauth2/token`, {
      method: 'POST',
      headers: { host, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: route.clientID,
        code,
        redirect_uri: route.redirectURI,
        code_verifier: PKCE_VERIFIER,
        resource: `${route.origin}/mcp`,
      }),
    }),
  );

  const body: unknown = await exchanged.json();

  const tokens = TokensSchema.safeParse(body);

  if (!tokens.success) {
    throw new Error(
      `the token request answered ${String(exchanged.status)}: ${JSON.stringify(body)}`,
    );
  }

  return tokens.data;
}
