import * as z from 'zod';
import { BasicUserSchema } from './exposure-schema';
import { NameSchema } from './name-schema';

// The same form as an imp name, so a secret name is never a path or a flag
// (impd keeps each value in a file by that name).
export const SecretNameSchema = NameSchema;

// Printable ASCII without spaces: every API token is, and a value with CR or
// LF could split the header impd sets from it.
const PrintableSchema = z.string().regex(/^[!-~]+$/, 'must be printable ASCII without spaces');

export const SecretValueSchema = PrintableSchema.min(1).max(8192);

// A hostname as a CONNECT names it: lowercase, no port, no wildcard. The last
// label starts with a letter, so an IP address is never one.
export const BrokerHostSchema = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-z0-9][a-z0-9-]{0,62}\.)+[a-z][a-z0-9-]{0,62}$/,
    'must be a lowercase hostname such as api.example.com',
  );

// Where a custom secret's requests go in place of https://<host>: an origin
// (http or https, optional port), with no credentials, path, query or
// fragment. It is kept as that origin, so a trailing slash is the same rule.
const BrokerUpstreamSchema = z
  .string()
  .max(2048)
  .transform((value, context) => {
    const url = URL.parse(value);

    if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      context.addIssue({ code: 'custom', message: 'must be an http or https URL' });

      return z.NEVER;
    }

    if (url.username !== '' || url.password !== '') {
      context.addIssue({ code: 'custom', message: 'must not hold a user name or password' });

      return z.NEVER;
    }

    if (url.search !== '' || url.hash !== '' || value.includes('?') || value.includes('#')) {
      context.addIssue({ code: 'custom', message: 'must not have a query or a fragment' });

      return z.NEVER;
    }

    if (url.pathname !== '/') {
      context.addIssue({ code: 'custom', message: 'must be an origin with no path' });

      return z.NEVER;
    }

    return url.origin;
  });

// The header impd sets for the host, and how it renders the value:
// `bearer` is `Bearer <value>`, `basic` is HTTP Basic with `user` as the
// user name, and `raw` is the value as it is. `upstream`, custom only.
export const BrokerRuleSchema = z.object({
  host: BrokerHostSchema,
  header: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/, 'must be a lowercase header name such as authorization'),
  scheme: z.enum(['bearer', 'basic', 'raw']),
  user: BasicUserSchema.optional(),
  upstream: BrokerUpstreamSchema.optional(),
});

export type BrokerRule = z.infer<typeof BrokerRuleSchema>;

// A preset fills the rules and the guest's placeholder variables; `custom`
// and `oauth` take their rules from the caller. An `oauth` secret's value is
// a refresh token, which impd exchanges for the access token the broker sets.
export const SecretKindSchema = z.enum(['github', 'anthropic', 'npm', 'custom', 'oauth']);

export type SecretKind = z.infer<typeof SecretKindSchema>;

// What an oauth secret needs to renew its access token: the token endpoint
// (https only) and the client the refresh token was issued to. `form` sends
// application/x-www-form-urlencoded, `json` a JSON body.
export const OAuthConfigSchema = z.object({
  tokenUrl: z.url({ protocol: /^https$/ }).max(2048),
  clientId: PrintableSchema.min(1).max(256),
  tokenFormat: z.enum(['json', 'form']).default('form'),
});

export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;

// An oauth secret's state, never a token. `error` is a short reason such as
// `invalid_grant` or `HTTP 503`. `idClaims` is the ID token's payload
// (identifiers, not credentials) that any token able to list secrets sees.
const OAuthStateSchema = OAuthConfigSchema.extend({
  status: z.enum(['pending', 'ready', 'needs_login']),
  expiresAt: z.date().nullable(),
  refreshedAt: z.date().nullable(),
  error: z.string().nullable(),
  idClaims: z.record(z.string(), z.unknown()).readonly().nullable(),
});

// What the API shows of a secret. The value never leaves impd.
export const SecretSchema = z.object({
  name: SecretNameSchema,
  kind: SecretKindSchema,
  rules: z.array(BrokerRuleSchema).readonly(),

  // the imps it is granted to
  imps: z.array(NameSchema).readonly(),
  createdAt: z.date(),

  // only for kind oauth
  oauth: OAuthStateSchema.optional(),
});

export type Secret = z.infer<typeof SecretSchema>;

// What secrets.add answers: the secret, and the grants a rebind dropped
export const SecretAddedSchema = SecretSchema.extend({
  droppedGrants: z.int().nonnegative().default(0),
});

export type SecretAdded = z.infer<typeof SecretAddedSchema>;

// An HTTP method as a request line names it: an uppercase token such as GET
const GrantMethodSchema = z
  .string()
  .regex(/^[A-Z]{1,16}$/, 'must be an uppercase method such as GET');

// Matched segment by segment: `*` is any one non-empty segment, a last `**`
// the rest of the path, none included. No `%`: a pattern names a path only as
// the URL parser leaves it (docs/guides/connectors.md#narrow-a-grant).
const GrantPathSchema = z
  .string()
  .max(512)
  .regex(
    /^(?:\/(?:\*|[A-Za-z0-9._~!$&'()+,;=:@-]*))*(?:\/\*\*)?$/,
    'must be a path such as /v1/messages, with * for one segment and a last /** for the rest',
  )
  .refine((path) => path.startsWith('/'), 'must start with /');

// What a grant limits its credential to (docs/guides/connectors.md#narrow-a-grant):
// a request gets it only when its method is one of `methods` and its path
// matches one of `paths`. A list left out allows any method or any path.
export const GrantFilterSchema = z
  .object({
    methods: z.array(GrantMethodSchema).min(1).max(16).readonly().optional(),
    paths: z.array(GrantPathSchema).min(1).max(64).readonly().optional(),
  })
  .refine(
    (filter) => filter.methods !== undefined || filter.paths !== undefined,
    'must name methods, paths or both',
  );

export type GrantFilter = z.infer<typeof GrantFilterSchema>;

// One secret granted to an imp, with its filter; null for the whole host
export const GrantSchema = z.object({
  secret: SecretNameSchema,
  filter: GrantFilterSchema.nullable(),
});

export type Grant = z.infer<typeof GrantSchema>;

// Why the broker refused a request, before any credential was added.
const AuditRefusalSchema = z.enum([
  // the front port's head was not HTTP/1, not a CONNECT, or not to host:port
  'not-http',
  'not-connect',
  'bad-target',

  // the imp held its most connections through the broker
  'connection-limit',

  // the imp's egress policy does not allow the host
  'egress-policy',

  // the host resolves only to an address no tunnel may reach
  'address-refused',

  // a Host header for another name than the connection's
  'wrong-host',

  // an upgrade to a WebSocket, which the broker does not carry
  'websocket',

  // the grant for the host was gone when the request came
  'no-grant',

  // the request's method or path is outside the grant's filter
  'outside-filter',
]);

export type AuditRefusal = z.infer<typeof AuditRefusalSchema>;

// One request the broker sent upstream with a credential. The path has no
// query string, and no header is kept.
export const AuditEntrySchema = z.object({
  at: z.date(),
  imp: NameSchema,
  secret: SecretNameSchema,
  method: z.string(),
  host: BrokerHostSchema,
  path: z.string(),

  // 502 when the upstream could not be reached
  status: z.int(),
  requestBytes: z.int().nonnegative(),
  responseBytes: z.int().nonnegative(),
  durationMs: z.int().nonnegative(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// One request the broker refused, which got no credential. Nothing from a
// header, the query or a body is kept.
export const RefusedRequestSchema = z.object({
  at: z.date(),
  imp: NameSchema,

  // null when the head named none
  method: z.string().nullable(),

  // the host as the guest named it, an IP address included; null when the
  // head named none
  host: z.string().max(253).nullable(),

  // null for a CONNECT, which has none
  path: z.string().nullable(),

  // the status the guest got
  status: z.int(),
  durationMs: z.int().nonnegative(),
  reason: AuditRefusalSchema,
});

export type RefusedRequest = z.infer<typeof RefusedRequestSchema>;
