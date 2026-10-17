import { randomBytes } from 'node:crypto';
import { mcp } from '@better-auth/mcp';
import { oauthProvider } from '@better-auth/oauth-provider';
import type { OAuthOptions, Scope as ProviderScope } from '@better-auth/oauth-provider';
import { hasScope } from '@impz/api';
import type { OAuthApproval, OAuthClient, OAuthGrant, Scope } from '@impz/api';
import { betterAuth } from 'better-auth';
import type { BetterAuthPlugin } from 'better-auth';
import { isAPIError } from 'better-auth/api';
import { buildConflictError, buildNotFoundError } from '../api-errors';
import type { Caller } from '../auth/caller';
import type { Revocations } from '../auth/revocations';
import type { TokenStore } from '../auth/token-store';
import type { ImpDatabase } from '../db/open-database';
import { CLIENT_SCOPES, buildApproverPlugin } from './build-approver-plugin';
import { createSignIns } from './create-sign-ins';
import { deriveTokenHash } from './derive-token-hash';
import { isPatternsWithin, pickGrantScope, readLowerScope } from './grant-limits';
import { makeOAuthRouter } from './make-oauth-router';
import type { AuthServer } from './make-oauth-router';
import type { PublicMcpConfig } from './public-mcp-config';

// The public MCP route's authorization server (docs/guides/mcp.md#public-route):
// better-auth's OAuth provider and MCP plugins, set up as atc sets them up.
// Each approved sign-in is one better-auth user, which is the grant.

const MINUTE_MS = 60_000;
const ACCESS_TOKEN_S = 15 * 60;

// an inactivity timeout: each refresh issues a new refresh token
const REFRESH_TOKEN_S = 30 * 24 * 60 * 60;

// how long an authorization code waits for its exchange
const CODE_S = 10 * 60;

// a grant's last use is written at most this often
const TOUCH_MS = MINUTE_MS;

// a user with no refresh token this long after its sign-in never exchanged
// its code, and goes
const UNUSED_SIGN_IN_MS = 60 * MINUTE_MS;

export interface McpAuth {
  readonly resource: string;
  readonly issuer: string;

  readonly listClients: () => Promise<OAuthClient[]>;
  readonly addClient: (name: string, redirectUris: readonly string[]) => Promise<OAuthClient>;
  readonly updateClient: (name: string, redirectUris: readonly string[]) => Promise<OAuthClient>;
  readonly removeClient: (name: string) => Promise<void>;
  readonly listGrants: () => Promise<OAuthGrant[]>;
  readonly removeGrant: (id: string) => Promise<void>;

  readonly readApproval: (code: string, approver: Readonly<Caller>) => OAuthApproval;
  readonly approve: (
    code: string,
    approver: Readonly<Caller>,
    scope: Scope,
    imps: readonly string[] | undefined,
  ) => void;

  // the route's OAuth paths; null for any other request
  readonly handle: (request: Request) => Promise<Response | null>;

  // the caller an access token stands for now, or null
  readonly resolveAccess: (bearer: string) => Promise<Caller | null>;
  readonly removeExpired: () => Promise<void>;
}

interface McpAuthDeps {
  readonly db: ImpDatabase;
  readonly tokens: TokenStore;
  readonly revocations: Revocations;

  // null: the route is off, and only the admin procedures answer
  readonly config: PublicMcpConfig | null;

  // impd's clock, for the sign-ins and a grant's last use; better-auth
  // reads the wall clock, so every compare with its rows does too
  readonly now: () => number;
  readonly log: (message: string) => void;
}

export function createMcpAuth(deps: Readonly<McpAuthDeps>): McpAuth {
  // better-auth reads these when it builds its context; an empty endpoint
  // turns its telemetry into a no-op
  process.env['BETTER_AUTH_TELEMETRY'] = '0';
  process.env['BETTER_AUTH_TELEMETRY_ENDPOINT'] = '';

  const origin = deps.config?.origin ?? 'http://127.0.0.1';
  const resource = `${origin}/mcp`;
  const db = deps.db;

  const providerOptions: OAuthOptions<ProviderScope[]> = {
    loginPage: '/login',
    consentPage: '/consent',
    scopes: CLIENT_SCOPES,
    disableJwtPlugin: true,
    allowDynamicClientRegistration: false,
    grantTypes: ['authorization_code', 'refresh_token'],

    // impd serves one resource, so every client may request it
    enforcePerClientResources: false,
    accessTokenExpiresIn: ACCESS_TOKEN_S,
    refreshTokenExpiresIn: REFRESH_TOKEN_S,
    codeExpiresIn: CODE_S,
    refreshTokenReuseInterval: 0,
    storeTokens: { hash: (token: string) => Promise.resolve(deriveTokenHash(token)) },
  };

  const provider =
    deps.config === null ? oauthProvider(providerOptions) : mcp({ ...providerOptions, resource });

  const auth = betterAuth({
    baseURL: origin,
    basePath: '/',

    // drawn at start, so a restart ends the sign-ins in progress and no grant
    secret: randomBytes(32).toString('base64url'),
    database: { db, type: 'sqlite' },
    telemetry: { enabled: false },
    logger: { disabled: true },

    // Off: it counts by client address, which the public listener never reads,
    // so all callers would share one bucket. A guess fails on 32 random
    // characters and PKCE, not a limit; impd limits sign-ins itself.
    rateLimit: { enabled: false },

    // migration 034 made the tables; a check at start would only repeat it
    advanced: { database: { validateSchema: false } },
    trustedOrigins: [origin],

    // a session lives only to carry one approval from the login page through
    // consent to the code exchange, which every token detaches from
    session: { expiresIn: 3 * CODE_S, disableSessionRefresh: true },
    user: {
      additionalFields: {
        tokenId: { type: 'string', required: true, input: false },
        imps: { type: 'string', required: false, input: false },
        lastUsedAt: { type: 'date', required: false, input: false },
      },
    },

    // the provider's endpoint types do not satisfy the plugin type under
    // exactOptionalPropertyTypes, as atc found
    // oxlint-disable-next-line no-unsafe-type-assertion -- a BetterAuthPlugin at runtime; only its endpoint option types disagree with the stricter compiler settings
    plugins: [provider as BetterAuthPlugin, buildApproverPlugin()],
  });

  const signIns = createSignIns({ now: deps.now });

  // a grant's user, its tokens and consents go, and what it opened ends
  const removeGrantRows = async (ids: readonly string[], why: string): Promise<void> => {
    if (ids.length === 0) {
      return;
    }

    await db.deleteFrom('user').where('id', 'in', ids).execute();

    for (const id of ids) {
      deps.revocations.revoke(id);
      deps.log(`impd: oauth: grant ${id} revoked: ${why}`);
    }
  };

  // the approver as it is now; null once its token is gone or no longer
  // covers the grant, which then ends
  const readApprover = (tokenID: string, scope: Scope, imps: readonly string[] | null) => {
    const token = deps.tokens.findById(tokenID);

    if (token === null || !hasScope(token.scope, scope)) {
      return null;
    }

    return isPatternsWithin(imps, token.imps) ? token : null;
  };

  const server: AuthServer = {
    handler: (request) => auth.handler(request),

    // resuming the authorization reads the request better-auth was called with
    signIn: (oauthQuery, approval) => {
      const headers = new Headers({
        accept: 'application/json',
        'content-type': 'application/json',
      });

      return auth.api.signInApproval({
        body: {
          oauth_query: oauthQuery,
          tokenID: approval.tokenID,
          tokenName: approval.tokenName,
          imps: approval.imps === null ? null : [...approval.imps],
        },
        headers,
        request: new Request(`${origin}/imp/sign-in-approval`, { method: 'POST', headers }),
        asResponse: true,
      });
    },
    findSessionID: async (cookie) => {
      const found = await auth.api.getSession({ headers: new Headers({ cookie }) });

      return found?.session.id ?? null;
    },
    readSecret: async () => {
      const context = await auth.$context;

      return context.secret;
    },
    readSessionCookie: async () => {
      const context = await auth.$context;

      const cookie = context.authCookies.sessionToken;

      return { name: cookie.name, secure: cookie.attributes.secure === true };
    },
  };

  const handle = makeOAuthRouter({
    auth: server,
    db,
    signIns,
    origin,
    resource,
    isOn: deps.config !== null,
    now: deps.now,
    log: deps.log,
    readApprover,
    removeGrantRows,
  });

  const requireClient = async (name: string) => {
    const client = await db
      .selectFrom('oauthClient')
      .select(['clientId', 'name', 'redirectUris', 'createdAt'])
      .where('name', '=', name)
      .executeTakeFirst();

    if (client === undefined) {
      throw buildNotFoundError('oauth-client', name);
    }

    return client;
  };

  const hasClientNamed = async (name: string): Promise<boolean> => {
    const client = await db
      .selectFrom('oauthClient')
      .select('clientId')
      .where('name', '=', name)
      .executeTakeFirst();

    return client !== undefined;
  };

  // The name's unique index refuses a second add that ran beside the first,
  // past both lookups; it answers as the lookup would.
  const createFixedClient = async (name: string, redirectUris: readonly string[]) => {
    try {
      return await auth.api.createFixedClient({ body: { name, redirectURIs: [...redirectUris] } });
    } catch (error) {
      const isTaken = await hasClientNamed(name);

      if (isTaken) {
        throw buildConflictError('oauth-client', name);
      }

      throw error;
    }
  };

  return {
    resource,
    issuer: origin,

    listClients: async () => {
      const rows = await db
        .selectFrom('oauthClient')
        .select(['clientId', 'name', 'redirectUris', 'createdAt'])
        .orderBy('name')
        .execute();

      return rows.map((row) => toClient(row));
    },

    addClient: async (name, redirectUris) => {
      const isTaken = await hasClientNamed(name);

      if (isTaken) {
        throw buildConflictError('oauth-client', name);
      }

      const made = await createFixedClient(name, redirectUris);

      return {
        name,
        clientId: made.clientID,
        redirectUris,
        createdAt: new Date(made.createdAt),
      };
    },

    updateClient: async (name, redirectUris) => {
      const client = await requireClient(name);

      await db
        .updateTable('oauthClient')
        .set({ redirectUris: JSON.stringify(redirectUris), updatedAt: new Date().toISOString() })
        .where('clientId', '=', client.clientId)
        .execute();

      return toClient({ ...client, redirectUris: JSON.stringify(redirectUris) });
    },

    removeClient: async (name) => {
      const client = await requireClient(name);

      signIns.removeClient(client.clientId);

      const grants = await db
        .selectFrom('oauthAccessToken')
        .select('userId')
        .where('clientId', '=', client.clientId)
        .union(
          db
            .selectFrom('oauthRefreshToken')
            .select('userId')
            .where('clientId', '=', client.clientId),
        )
        .execute();

      await removeGrantRows(
        grants.flatMap((row) => (row.userId === null ? [] : [row.userId])),
        `its client ${name} was removed`,
      );

      await db.deleteFrom('oauthClient').where('clientId', '=', client.clientId).execute();
    },

    listGrants: async () => {
      const rows = await db
        .selectFrom('oauthRefreshToken')
        .innerJoin('user', 'user.id', 'oauthRefreshToken.userId')
        .leftJoin('oauthClient', 'oauthClient.clientId', 'oauthRefreshToken.clientId')
        .select([
          'user.id',
          'user.name as tokenName',
          'user.tokenId',
          'user.imps',
          'user.createdAt',
          'user.lastUsedAt',
          'oauthRefreshToken.scopes',
          'oauthRefreshToken.clientId',
          'oauthClient.name as clientName',
        ])
        .where('oauthRefreshToken.revoked', 'is', null)
        .where('oauthRefreshToken.expiresAt', '>', new Date().toISOString())
        .orderBy('user.createdAt')
        .execute();

      return rows.map((row) => ({
        id: row.id,
        client: row.clientName ?? row.clientId,
        token: deps.tokens.findById(row.tokenId)?.name ?? row.tokenName,
        scope: pickGrantScope(parseStrings(row.scopes)),
        imps: parseImps(row.imps),
        createdAt: new Date(row.createdAt),
        lastUsedAt: row.lastUsedAt === null ? null : new Date(row.lastUsedAt),
      }));
    },

    removeGrant: async (id) => {
      const removed = await db.deleteFrom('user').where('id', '=', id).executeTakeFirst();

      if (removed.numDeletedRows === 0n) {
        throw buildNotFoundError('oauth-grant', id);
      }

      deps.revocations.revoke(id);
    },

    readApproval: (code, approver) => signIns.readApproval(code, approver),

    approve: (code, approver, scope, imps) => {
      const approved = signIns.approve(code, approver, scope, imps);

      deps.log(
        `impd: oauth: a sign-in for ${approved.clientName} approved by token ${approver.name}`,
      );
    },

    handle,

    resolveAccess: async (bearer) => {
      let payload: unknown;

      try {
        payload = await auth.api.verifyMCPAccessToken({ body: { token: bearer } });
      } catch (error) {
        if (isAPIError(error)) {
          return null;
        }

        throw error;
      }

      const access = readAccessPayload(payload);

      if (access === null || !access.audiences.includes(resource)) {
        return null;
      }

      const grant = await db
        .selectFrom('user')
        .select(['id', 'tokenId', 'imps', 'lastUsedAt'])
        .where('id', '=', access.userID)
        .executeTakeFirst();

      if (grant === undefined || deps.revocations.isRevoked(grant.id)) {
        return null;
      }

      const scope = pickGrantScope(access.scopes);
      const imps = parseImps(grant.imps);
      const approver = readApprover(grant.tokenId, scope, imps);

      if (approver === null) {
        await removeGrantRows([grant.id], 'the token that approved it no longer covers it');

        return null;
      }

      const at = deps.now();

      if (grant.lastUsedAt === null || at - Date.parse(grant.lastUsedAt) >= TOUCH_MS) {
        await db
          .updateTable('user')
          .set({ lastUsedAt: new Date(at).toISOString() })
          .where('id', '=', grant.id)
          .execute();
      }

      const client = await db
        .selectFrom('oauthClient')
        .select('name')
        .where('clientId', '=', access.clientID)
        .executeTakeFirst();

      const clientName = client?.name ?? access.clientID;

      return {
        kind: 'oauth',
        name: `${clientName}/${grant.id}`,
        scope: readLowerScope(scope, approver.scope),
        imps,

        // the approver's own list: a grant then meets every refusal its
        // token would, such as no fork; grants of secrets stay refused
        grantable: approver.grantable,

        // an MCP client adds no image, whatever its token may
        imageRefPrefix: null,
        tokenId: approver.tokenId,
        grantId: grant.id,
        expiresAt: approver.expiresAt,
        principal: `grant:${grant.id}`,
        display: `${clientName} via ${approver.display}`,
      };
    },

    removeExpired: async () => {
      const at = new Date().toISOString();

      const stale = await db
        .selectFrom('user')
        .select('id')
        .where('createdAt', '<', new Date(Date.now() - UNUSED_SIGN_IN_MS).toISOString())
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('oauthRefreshToken')
                .select('oauthRefreshToken.id')
                .whereRef('oauthRefreshToken.userId', '=', 'user.id')
                .where('oauthRefreshToken.revoked', 'is', null)
                .where('oauthRefreshToken.expiresAt', '>', at),
            ),
          ),
        )
        .execute();

      await removeGrantRows(
        stale.map((row) => row.id),
        'its refresh token expired',
      );

      // a live rotated refresh token stays, so a replay of it still ends its grant
      await db.deleteFrom('oauthRefreshToken').where('expiresAt', '<', at).execute();
      await db.deleteFrom('oauthAccessToken').where('expiresAt', '<', at).execute();
      await db.deleteFrom('session').where('expiresAt', '<', at).execute();
      await db.deleteFrom('verification').where('expiresAt', '<', at).execute();
    },
  };
}

interface AccessPayload {
  readonly userID: string;
  readonly clientID: string;
  readonly audiences: readonly string[];
  readonly scopes: readonly string[];
}

// The fields of better-auth's introspection payload a grant needs; null for
// one without a user or client, or one bound to a key (`cnf`), since the
// route checks no proof of the key and a stolen bound token must not pass.
function readAccessPayload(payload: unknown): AccessPayload | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const fields = new Map<string, unknown>(Object.entries(payload));

  if (fields.get('cnf') !== undefined && fields.get('cnf') !== null) {
    return null;
  }

  const userID = fields.get('sub');
  const clientID = fields.get('client_id');
  const scope = fields.get('scope');
  const audience: unknown = fields.get('aud');

  if (typeof userID !== 'string' || typeof clientID !== 'string' || clientID === '') {
    return null;
  }

  return {
    userID,
    clientID,
    audiences: [audience].flat().filter((item): item is string => typeof item === 'string'),
    scopes: typeof scope === 'string' ? scope.split(' ') : [],
  };
}

function parseStrings(text: string): string[] {
  const parsed: unknown = JSON.parse(text);

  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
}

function parseImps(text: string | null): string[] | null {
  if (text === null) {
    return null;
  }

  const parsed: unknown = JSON.parse(text);

  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
}

interface ClientRow {
  readonly clientId: string;
  readonly name: string | null;
  readonly redirectUris: string;
  readonly createdAt: string | null;
}

function toClient(row: Readonly<ClientRow>): OAuthClient {
  return {
    name: row.name ?? row.clientId,
    clientId: row.clientId,
    redirectUris: parseStrings(row.redirectUris),
    createdAt: new Date(row.createdAt ?? 0),
  };
}
