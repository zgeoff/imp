import * as z from 'zod';
import { NameSchema } from './name-schema';
import { ScopeSchema } from './token-schema';

// OAuth for the public MCP route (docs/guides/mcp.md#public-route): the
// clients an operator adds, the grants people approve, and the approvals
// that wait for them.

// the most redirect URIs one client holds
const MAX_REDIRECT_URIS = 8;

// https anywhere, or http on a loopback host, with no fragment; matched
// exactly, as the client sends it
export const RedirectUriSchema = z
  .string()
  .max(2048)
  .refine(
    isAllowedRedirectUri,
    'must be an https URL, or http on a loopback host, with no fragment',
  );

export const RedirectUrisSchema = z
  .array(RedirectUriSchema)
  .min(1)
  .max(MAX_REDIRECT_URIS)
  .refine((uris) => new Set(uris).size === uris.length, 'must not name a redirect URI twice');

// a grant's pattern: an imp name, or a name prefix and a trailing `*`; a
// grant narrower than its token needs no other form
export const GrantPatternSchema = z
  .string()
  .regex(
    /^(?:\*|[a-z][a-z0-9-]{0,30}|[a-z][a-z0-9-]{0,29}\*)$/,
    'must be an imp name, or a name prefix and a trailing *, such as dev-*',
  );

// what `GET /oauth/authorize` shows: 8 symbols of 32, 40 bits, with or
// without the dash, in any case
export const ApprovalCodeSchema = z
  .string()
  .trim()
  .transform((code) => code.toUpperCase().replaceAll('-', ''))
  .pipe(
    z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/, 'must be the 8-symbol code the sign-in page shows'),
  );

export const OAuthClientSchema = z.object({
  name: NameSchema,

  // what the connector's OAuth settings take; it has no secret
  clientId: z.string(),
  redirectUris: z.array(z.string()).readonly(),
  createdAt: z.date(),
});

export type OAuthClient = z.infer<typeof OAuthClientSchema>;

export const OAuthGrantSchema = z.object({
  id: z.string(),
  client: NameSchema,

  // the token that approved it, which bounds it for as long as both live
  token: NameSchema,
  scope: ScopeSchema,
  imps: z.array(GrantPatternSchema).readonly().nullable(),
  createdAt: z.date(),

  // the last access token or refresh it answered; null until its first
  lastUsedAt: z.date().nullable(),
});

export type OAuthGrant = z.infer<typeof OAuthGrantSchema>;

// a sign-in that waits for `imp oauth approve`, as its approver sees it
export const OAuthApprovalSchema = z.object({
  client: NameSchema,
  redirectUri: z.string(),

  // the highest scope the client asked for; an approval may give less
  requestedScope: ScopeSchema,
  requestedAt: z.date(),
  expiresAt: z.date(),
});

export type OAuthApproval = z.infer<typeof OAuthApprovalSchema>;

function isAllowedRedirectUri(text: string): boolean {
  let url: URL;

  try {
    url = new URL(text);
  } catch {
    return false;
  }

  if (text.includes('#')) {
    return false;
  }

  if (url.protocol === 'https:') {
    return true;
  }

  return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
}
