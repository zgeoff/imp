import { getOAuthProviderApi } from '@better-auth/oauth-provider';
import { ScopeSchema } from '@impz/api';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { generateRandomString } from 'better-auth/crypto';
import * as z from 'zod';

// every scope a client may ask for: imp's three, and offline_access, which
// every authorization adds so each grant gets a refresh token
export const CLIENT_SCOPES = [...ScopeSchema.options, 'offline_access'];

// better-auth needs an email for every user; no mail ever reaches this one
const APPROVAL_EMAIL_DOMAIN = 'approval.imp.invalid';

const SignInBodySchema = z.object({
  oauth_query: z.string(),
  tokenID: z.string().min(1),
  tokenName: z.string().min(1),
  imps: z.array(z.string()).nullable(),
});

const FixedClientBodySchema = z.object({
  name: z.string().min(1),
  redirectURIs: z.array(z.string()).min(1),
});

// The plugin that makes each approved sign-in one better-auth user. Its
// endpoints are server-only, so only impd's own routes reach them.
export function buildApproverPlugin() {
  return {
    id: 'imp-approver',
    endpoints: {
      signInApproval: createAuthEndpoint(
        '/imp/sign-in-approval',
        {
          method: 'POST',
          body: SignInBodySchema,
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const adapter = ctx.context.internalAdapter;
          const local = generateRandomString(24, 'a-z', '0-9');

          const user = await adapter.createUser(
            {
              email: `${local}@${APPROVAL_EMAIL_DOMAIN}`,
              name: ctx.body.tokenName,
              emailVerified: true,
              tokenId: ctx.body.tokenID,
              imps: ctx.body.imps === null ? null : JSON.stringify(ctx.body.imps),
            },
            { method: 'admin' },
          );

          const session = await adapter.createSession(user.id);

          await setSessionCookie(ctx, { session, user });

          return ctx.json({ signedIn: true });
        },
      ),
      verifyMCPAccessToken: createAuthEndpoint(
        '/imp/verify-access-token',
        {
          method: 'POST',
          body: z.object({ token: z.string() }),
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const provider = ctx.context.getPlugin('oauth-provider');

          if (provider === null) {
            throw new Error('the oauth-provider plugin is not installed');
          }

          const payload = await getOAuthProviderApi(ctx, provider.options).requireActiveAccessToken(
            ctx.body.token,
          );

          return ctx.json(payload);
        },
      ),
      createFixedClient: createAuthEndpoint(
        '/imp/create-fixed-client',
        {
          method: 'POST',
          body: FixedClientBodySchema,
          metadata: { SERVER_ONLY: true },
        },
        async (ctx) => {
          const clientID = `impc_${generateRandomString(32, 'a-z', 'A-Z', '0-9')}`;

          const now = new Date();

          const isWeb = ctx.body.redirectURIs.every((uri) => uri.startsWith('https:'));

          await ctx.context.adapter.create({
            model: 'oauthClient',
            data: {
              clientId: clientID,
              name: ctx.body.name,
              redirectUris: ctx.body.redirectURIs,
              scopes: CLIENT_SCOPES,
              clientCredentialsScopes: [],
              tokenEndpointAuthMethod: 'none',
              grantTypes: ['authorization_code', 'refresh_token'],
              responseTypes: ['code'],
              applicationType: isWeb ? 'web' : 'native',
              requirePKCE: true,
              disabled: false,
              createdAt: now,
              updatedAt: now,
            },
          });

          return ctx.json({ clientID, createdAt: now.toISOString() });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
