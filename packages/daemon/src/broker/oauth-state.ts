import * as z from 'zod';

// The value file of an oauth secret: JSON, the only value file impd rewrites
// (docs/guides/connectors.md#value-files). It holds the tokens, so nothing
// here logs or returns one.

const TokenSchema = z.string().min(1).max(16_384);

const StateSchema = z.object({
  v: z.literal(1),
  refreshToken: TokenSchema,
  accessToken: TokenSchema.nullable(),
  idToken: TokenSchema.nullable(),

  // ms since the epoch
  expiresAt: z.number().nullable(),
  refreshedAt: z.number().nullable(),
  status: z.enum(['pending', 'ready', 'needs_login']),

  // a short reason, never a response body
  error: z.string().max(200).nullable(),
});

export type OAuthStateFile = z.infer<typeof StateSchema>;

export function buildPendingState(refreshToken: string): OAuthStateFile {
  return {
    v: 1,
    refreshToken,
    accessToken: null,
    idToken: null,
    expiresAt: null,
    refreshedAt: null,
    status: 'pending',
    error: null,
  };
}

// null when the text is not a state file
export function parseOAuthState(text: string): OAuthStateFile | null {
  try {
    const parsed = StateSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function formatOAuthState(state: Readonly<OAuthStateFile>): string {
  return JSON.stringify(state);
}

// a token goes into a header value: printable ASCII without spaces, so it
// cannot split the header
export function isHeaderSafeToken(token: string): boolean {
  return token.length > 0 && token.length <= 16_384 && /^[!-~]+$/.test(token);
}

// the keys of an ID token that identify one sign-in or one token, not the
// account
const DROPPED_CLAIMS = ['at_hash', 'c_hash', 'nonce', 'sid', 'jti'] as const;

// The payload of a JWT, decoded and not verified; null when it is not one.
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split('.');

  if (segments.length < 2 || segments[1] === undefined) {
    return null;
  }

  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return null;
    }

    return Object.fromEntries(Object.entries(payload));
  } catch {
    return null;
  }
}

// the ID token's claims without the per-token identifiers; null without an
// ID token or when it does not decode
export function readIdClaims(idToken: string | null): Record<string, unknown> | null {
  if (idToken === null) {
    return null;
  }

  const payload = decodeJwtPayload(idToken);

  if (payload === null) {
    return null;
  }

  for (const key of DROPPED_CLAIMS) {
    delete payload[key];
  }

  return payload;
}

// the `exp` of a JWT as ms since the epoch; null when it has none
export function readJwtExpiry(token: string): number | null {
  const exp = decodeJwtPayload(token)?.['exp'];

  return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}
