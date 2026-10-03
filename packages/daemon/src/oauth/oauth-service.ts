import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OAuthApproval, OAuthClient, OAuthGrant, Scope } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { buildConflictError, buildForbiddenError, buildNotFoundError } from '../api-errors';
import type { Caller } from '../auth/caller';
import type { Revocations } from '../auth/revocations';
import { hasScope } from '../auth/scopes';
import { ROOT_TOKEN_ID } from '../auth/token-store';
import type { TokenStore } from '../auth/token-store';
import {
  claimRefreshToken,
  findAccessToken,
  findOAuthClientById,
  findOAuthClientByName,
  findRefreshToken,
  listOAuthClients,
  listOAuthGrants,
  removeExpiredOAuthRows,
  removeOAuthClient,
  removeOAuthGrant,
  updateOAuthClientUris,
  updateOAuthGrantUse,
  writeOAuthClient,
  writeOAuthGrant,
} from '../db/oauth';
import type { IssuedTokens, OAuthClientRecord, OAuthGrantRecord } from '../db/oauth';
import type { ImpDatabase } from '../db/open-database';
import { createBuckets } from '../https/public-limits';
import { formatScopeList, isGrantPattern, isPatternsWithin, readLowerScope } from './grant-limits';
import {
  createApprovalCode,
  createCode,
  createId,
  createToken,
  formatApprovalCode,
  isChallenge,
  isSameHash,
  isVerifierMatch,
  parseToken,
  toSecretHash,
} from './oauth-secrets';
import type { OAuthTokenKind } from './oauth-secrets';
import type { PublicMcpConfig } from './public-mcp-config';

// The public MCP route's authorization server (docs/guides/mcp.md#public-route):
// fixed public clients, PKCE S256, sign-ins a named token approves, and
// opaque tokens checked per request against the grant and its token.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const ACCESS_TOKEN_MS = 15 * MINUTE_MS;

// an inactivity timeout: each refresh starts it again
export const REFRESH_TOKEN_MS = 30 * DAY_MS;
const CODE_MS = 10 * MINUTE_MS;
const APPROVAL_MS = 10 * MINUTE_MS;

// sign-ins waiting at once, in all and per client; a new one drops the oldest
const MAX_PENDING = 16;
const MAX_PENDING_PER_CLIENT = 3;

// a grant's last use is written at most this often
const TOUCH_MS = MINUTE_MS;

// sign-ins per client: with no client address, a flood with a client's
// public ID can hold back that client's sign-ins, and no other's
const AUTHORIZE_BUCKET = { size: 10, refillMs: 6000 };

// failed token requests per client; a valid one is never charged
const TOKEN_FAILURE_BUCKET = { size: 30, refillMs: 2000 };
const APPROVE_FAILURE_BUCKET = { size: 20, refillMs: 3000 };
const SCOPES: readonly Scope[] = ['read', 'exec', 'manage'];

// the failure bucket token requests from no known client share
const UNKNOWN_CLIENT_KEY = '';

export interface AuthorizeParams {
  readonly responseType: string | null;
  readonly clientId: string | null;
  readonly redirectUri: string | null;
  readonly codeChallenge: string | null;
  readonly codeChallengeMethod: string | null;
  readonly state: string | null;
  readonly scope: string | null;
  readonly resource: string | null;
}

// a sign-in as its page shows it
export interface PendingView {
  readonly id: string;
  readonly signature: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly requestedScope: Scope;
  readonly approvalCode: string;
  readonly expiresAt: number;

  // what the approver gave; null until `imp oauth approve`
  readonly approval: { readonly scope: Scope; readonly imps: readonly string[] | null } | null;
}

// why no redirect may go back: the page says so instead
export type AuthorizeErrorPage = 'unknown_client' | 'bad_redirect_uri' | 'expired' | 'bad_request';

export type AuthorizeOutcome =
  | { readonly kind: 'page'; readonly view: PendingView }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'error-page'; readonly error: AuthorizeErrorPage }
  | { readonly kind: 'too-many'; readonly retryS: number };

export type TokenOutcome =
  | { readonly status: 200; readonly body: TokenResponse }
  | { readonly status: 400 | 401 | 429; readonly body: OAuthErrorBody };

interface TokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

// a urlencoded request body, read and never changed
type OAuthForm = Readonly<Pick<URLSearchParams, 'get'>>;

interface OAuthErrorBody {
  readonly error: string;
  readonly error_description: string;
}

export interface OAuthService {
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

  readonly authorize: (params: Readonly<AuthorizeParams>) => Promise<AuthorizeOutcome>;
  readonly finish: (
    id: string,
    signature: string,
    action: 'continue' | 'allow' | 'deny',
  ) => AuthorizeOutcome;
  readonly exchange: (form: OAuthForm) => Promise<TokenOutcome>;
  readonly revokeToken: (form: OAuthForm) => Promise<TokenOutcome | null>;

  // the caller an access token stands for now, or null
  readonly resolveAccess: (bearer: string) => Promise<Caller | null>;
  readonly removeExpired: () => Promise<void>;
}

interface OAuthServiceDeps {
  readonly db: ImpDatabase;
  readonly tokens: TokenStore;
  readonly revocations: Revocations;

  // null: the route is off, and only the admin procedures answer
  readonly config: PublicMcpConfig | null;
  readonly now: () => number;
  readonly log: (message: string) => void;

  // signs each sign-in's id; drawn at start, so a restart ends the
  // sign-ins in progress and no grant
  readonly key: Buffer;
}

interface Approval {
  readonly tokenId: string;
  readonly scope: Scope;
  readonly imps: readonly string[] | null;
}

// one sign-in: everything but its approval is fixed when it starts
interface Pending {
  readonly id: string;
  readonly client: OAuthClientRecord;
  readonly redirectUri: string;
  readonly state: string | null;
  readonly challenge: string;
  readonly resource: string;
  readonly requestedScope: Scope;
  readonly approvalCode: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly approval: Approval | null;
}

// a code, bound to everything its exchange must present again
interface CodeEntry {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly challenge: string;
  readonly approval: Approval;
  readonly grantId: string;
  readonly expiresAt: number;
}

// a code exchanged once; an exchange that presents it again in full
// revokes what the first one made
interface SpentCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly grantId: string;
  readonly expiresAt: number;
  isReplayed: boolean;
}

export function createOAuthService(deps: Readonly<OAuthServiceDeps>): OAuthService {
  const origin = deps.config?.origin ?? 'http://127.0.0.1';
  const resource = `${origin}/mcp`;

  const pending = new Map<string, Pending>();
  const byApprovalCode = new Map<string, string>();
  const codes = new Map<string, CodeEntry>();
  const spentCodes = new Map<string, SpentCode>();

  const tryAuthorize = createBuckets(AUTHORIZE_BUCKET, deps.now);
  const tryTokenFailure = createBuckets(TOKEN_FAILURE_BUCKET, deps.now);
  const tryApproveFailure = createBuckets(APPROVE_FAILURE_BUCKET, deps.now);

  const buildSignature = (id: string): string =>
    createHmac('sha256', deps.key).update(id).digest('base64url');

  const isSigned = (id: string, signature: string): boolean => {
    const given = Buffer.from(signature);
    const expected = Buffer.from(buildSignature(id));

    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const removePending = (entry: Readonly<Pending>): void => {
    pending.delete(entry.id);
    byApprovalCode.delete(entry.approvalCode);
  };

  const removeStale = (): void => {
    const at = deps.now();

    for (const entry of pending.values()) {
      if (entry.expiresAt <= at) {
        removePending(entry);
      }
    }

    for (const [hash, entry] of codes) {
      if (entry.expiresAt <= at) {
        codes.delete(hash);
      }
    }

    for (const [hash, entry] of spentCodes) {
      if (entry.expiresAt <= at) {
        spentCodes.delete(hash);
      }
    }
  };

  const removeAndRevokeGrant = async (id: string, why: string): Promise<void> => {
    await removeOAuthGrant(deps.db, id);

    deps.revocations.revoke(id);
    deps.log(`impd: oauth: grant ${id} revoked: ${why}`);
  };

  // the approver as it is now; null once its token is gone or no longer
  // covers the grant, which then ends
  const readApprover = (approval: Readonly<Approval>): Caller | null => {
    const token = deps.tokens.findById(approval.tokenId);

    if (token === null || !hasScope(token.scope, approval.scope)) {
      return null;
    }

    return isPatternsWithin(approval.imps, token.imps) ? token : null;
  };

  const createTokens = (): {
    readonly texts: Record<OAuthTokenKind, string>;
    readonly rows: IssuedTokens;
  } => {
    const at = deps.now();
    const access = createToken('access');
    const refresh = createToken('refresh');

    return {
      texts: { access: access.text, refresh: refresh.text },
      rows: {
        access: { id: access.id, hash: access.hash, expiresAt: at + ACCESS_TOKEN_MS },
        refresh: { id: refresh.id, hash: refresh.hash, expiresAt: at + REFRESH_TOKEN_MS },
      },
    };
  };

  const buildTokenResponse = (
    texts: Record<OAuthTokenKind, string>,
    scope: Scope,
  ): TokenOutcome => ({
    status: 200,
    body: {
      access_token: texts.access,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_MS / 1000,
      refresh_token: texts.refresh,
      scope: formatScopeList(scope),
    },
  });

  // an error back to the client's redirect URI, with the issuer (RFC 9207)
  const buildErrorRedirect = (
    redirectUri: string,
    state: string | null,
    error: string,
    description: string,
  ): AuthorizeOutcome => ({
    kind: 'redirect',
    location: buildRedirect(redirectUri, {
      error,
      error_description: description,
      ...(state !== null && { state }),
      iss: origin,
    }),
  });

  const toView = (entry: Readonly<Pending>): PendingView => ({
    id: entry.id,
    signature: buildSignature(entry.id),
    clientName: entry.client.name,
    redirectUri: entry.redirectUri,
    requestedScope: entry.requestedScope,
    approvalCode: formatApprovalCode(entry.approvalCode),
    expiresAt: entry.expiresAt,
    approval:
      entry.approval === null ? null : { scope: entry.approval.scope, imps: entry.approval.imps },
  });

  // A new sign-in makes room by dropping the oldest unapproved one, of its
  // client's or of all, so a flood of page loads spares an approved one
  const registerPending = (entry: Readonly<Pending>): void => {
    const ofClient = [...pending.values()].filter((other) => other.client.id === entry.client.id);

    if (ofClient.length >= MAX_PENDING_PER_CLIENT) {
      const evicted = pickEvicted(ofClient);

      if (evicted !== undefined) {
        removePending(evicted);
      }
    }

    if (pending.size >= MAX_PENDING) {
      const evicted = pickEvicted([...pending.values()]);

      if (evicted !== undefined) {
        removePending(evicted);
      }
    }

    pending.set(entry.id, entry);
    byApprovalCode.set(entry.approvalCode, entry.id);
  };

  // the sign-in an approver names by its code; a miss counts against the
  // token's burst, so codes cannot be tried fast
  const requirePending = (code: string, approver: Readonly<Caller>): Pending => {
    const tokenId = requireNamedToken(approver);

    removeStale();

    const id = byApprovalCode.get(code);
    const entry = id === undefined ? undefined : pending.get(id);

    if (entry === undefined) {
      if (!tryApproveFailure(tokenId)) {
        throw new ORPCError('TOO_MANY_REQUESTS', {
          message: 'too many codes that match no sign-in; wait a few seconds',
        });
      }

      throw buildNotFoundError('oauth-approval', formatApprovalCode(code));
    }

    return entry;
  };

  const handleCodeExchange = async (
    client: Readonly<OAuthClientRecord>,
    form: OAuthForm,
  ): Promise<TokenOutcome> => {
    const code = form.get('code') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    const requested = form.get('resource');
    const hash = toSecretHash(code);
    const entry = codes.get(hash);

    if (entry === undefined) {
      const spent = spentCodes.get(hash);

      // only the whole exchange presented again counts as a replay
      if (
        spent !== undefined &&
        spent.expiresAt > deps.now() &&
        spent.clientId === client.id &&
        spent.redirectUri === redirectUri &&
        isVerifierMatch(verifier, spent.challenge)
      ) {
        spent.isReplayed = true;

        await removeAndRevokeGrant(spent.grantId, 'its code was exchanged twice');
      }

      return buildTokenError(400, 'invalid_grant', 'the code is not valid');
    }

    if (
      entry.expiresAt <= deps.now() ||
      entry.clientId !== client.id ||
      entry.redirectUri !== redirectUri ||
      !isVerifierMatch(verifier, entry.challenge)
    ) {
      return buildTokenError(400, 'invalid_grant', 'the code is not valid for this request');
    }

    if (requested !== null && requested !== entry.resource) {
      return buildTokenError(400, 'invalid_target', `the resource is ${entry.resource}`);
    }

    // spent here, with no await between the check and the spend
    codes.delete(hash);

    const spent: SpentCode = {
      clientId: entry.clientId,
      redirectUri: entry.redirectUri,
      challenge: entry.challenge,
      grantId: entry.grantId,
      expiresAt: entry.expiresAt,
      isReplayed: false,
    };

    spentCodes.set(hash, spent);

    if (readApprover(entry.approval) === null) {
      return buildTokenError(400, 'invalid_grant', 'the token that approved it is gone');
    }

    const issued = createTokens();

    const grant: OAuthGrantRecord = {
      id: entry.grantId,
      clientId: client.id,
      tokenId: entry.approval.tokenId,
      scope: entry.approval.scope,
      imps: entry.approval.imps,
      resource: entry.resource,
      createdAt: new Date(deps.now()),
      lastUsedAt: null,
    };

    await writeOAuthGrant(deps.db, grant, issued.rows, deps.now());

    // a replay came in while the grant was written
    if (spent.isReplayed) {
      await removeAndRevokeGrant(grant.id, 'its code was exchanged twice');

      return buildTokenError(400, 'invalid_grant', 'the code is not valid');
    }

    deps.log(`impd: oauth: grant ${grant.id} for ${client.name} made`);

    return buildTokenResponse(issued.texts, grant.scope);
  };

  const handleRefresh = async (
    client: Readonly<OAuthClientRecord>,
    form: OAuthForm,
  ): Promise<TokenOutcome> => {
    const parsed = parseToken('refresh', form.get('refresh_token') ?? '');
    const row = parsed === null ? undefined : await findRefreshToken(deps.db, parsed.id);

    // a wrong secret, a guessed id or another client's token revokes nothing
    if (
      parsed === null ||
      row === undefined ||
      !isSameHash(toSecretHash(parsed.secret), row.hash) ||
      row.grant.clientId !== client.id ||
      row.expiresAt <= deps.now()
    ) {
      return buildTokenError(400, 'invalid_grant', 'the refresh token is not valid');
    }

    const grant = row.grant;
    const requested = form.get('resource');

    if (requested !== null && requested !== grant.resource) {
      return buildTokenError(400, 'invalid_target', `the resource is ${grant.resource}`);
    }

    const asked = readScopeList(form.get('scope'));

    if (asked === null || asked.some((scope) => !hasScope(grant.scope, scope))) {
      return buildTokenError(
        400,
        'invalid_scope',
        `the grant holds ${formatScopeList(grant.scope)}`,
      );
    }

    if (readApprover({ tokenId: grant.tokenId, scope: grant.scope, imps: grant.imps }) === null) {
      await removeAndRevokeGrant(grant.id, 'the token that approved it no longer covers it');

      return buildTokenError(400, 'invalid_grant', 'the grant ended');
    }

    // the right client with a valid token already spent: a replay
    if (row.spentAt !== null) {
      await removeAndRevokeGrant(grant.id, 'a spent refresh token was used again');

      return buildTokenError(400, 'invalid_grant', 'the refresh token was used already');
    }

    const issued = createTokens();

    const isRotated = await claimRefreshToken(
      deps.db,
      parsed.id,
      grant.id,
      issued.rows,
      deps.now(),
    );

    if (!isRotated) {
      await removeAndRevokeGrant(grant.id, 'a spent refresh token was used again');

      return buildTokenError(400, 'invalid_grant', 'the refresh token was used already');
    }

    return buildTokenResponse(issued.texts, grant.scope);
  };

  // the known client a token request names; an unknown one is a failure
  // charged to one shared key
  const requireTokenClient = async (form: OAuthForm): Promise<OAuthClientRecord | TokenOutcome> => {
    const clientId = form.get('client_id');
    const client = clientId === null ? undefined : await findOAuthClientById(deps.db, clientId);

    if (client === undefined) {
      return applyFailureCharge(
        UNKNOWN_CLIENT_KEY,
        buildTokenError(401, 'invalid_client', 'no such client'),
      );
    }

    return client;
  };

  // A failed token request costs its client one token; past the burst a
  // failure answers slow_down instead, so its cause stays hidden. A valid
  // request never pays, so a flood cannot hold back a real refresh.
  const applyFailureCharge = (key: string, outcome: TokenOutcome): TokenOutcome => {
    if (outcome.status === 200 || tryTokenFailure(key)) {
      return outcome;
    }

    return buildTokenError(429, 'slow_down', 'too many failed token requests from this client');
  };

  return {
    resource,
    issuer: origin,

    listClients: async () => {
      const clients = await listOAuthClients(deps.db);

      return clients.map((client) => toClient(client));
    },
    addClient: async (name, redirectUris) => {
      const existing = await findOAuthClientByName(deps.db, name);

      if (existing !== undefined) {
        throw buildConflictError('oauth-client', name);
      }

      const client: OAuthClientRecord = {
        id: `impc_${createId()}`,
        name,
        redirectUris,
        createdAt: new Date(deps.now()),
      };

      await writeOAuthClient(deps.db, client);

      return toClient(client);
    },
    updateClient: async (name, redirectUris) => {
      const client = await findOAuthClientByName(deps.db, name);

      if (client === undefined) {
        throw buildNotFoundError('oauth-client', name);
      }

      await updateOAuthClientUris(deps.db, client.id, redirectUris);

      return toClient({ ...client, redirectUris });
    },
    removeClient: async (name) => {
      const client = await findOAuthClientByName(deps.db, name);

      if (client === undefined) {
        throw buildNotFoundError('oauth-client', name);
      }

      for (const entry of pending.values()) {
        if (entry.client.id === client.id) {
          removePending(entry);
        }
      }

      for (const [hash, entry] of codes) {
        if (entry.clientId === client.id) {
          codes.delete(hash);
        }
      }

      const grantIds = await removeOAuthClient(deps.db, client.id);

      for (const grantId of grantIds) {
        deps.revocations.revoke(grantId);
      }
    },
    listGrants: async () => {
      const clientRows = await listOAuthClients(deps.db);

      const clients = new Map(clientRows.map((client) => [client.id, client.name]));

      const grants = await listOAuthGrants(deps.db);

      return grants.map((grant) => ({
        id: grant.id,
        client: clients.get(grant.clientId) ?? grant.clientId,
        token: deps.tokens.findById(grant.tokenId)?.name ?? grant.tokenId,
        scope: grant.scope,
        imps: grant.imps,
        createdAt: grant.createdAt,
        lastUsedAt: grant.lastUsedAt,
      }));
    },
    removeGrant: async (id) => {
      const isRemoved = await removeOAuthGrant(deps.db, id);

      if (!isRemoved) {
        throw buildNotFoundError('oauth-grant', id);
      }

      deps.revocations.revoke(id);
    },

    readApproval: (code, approver) => {
      const entry = requirePending(code, approver);

      return {
        client: entry.client.name,
        redirectUri: entry.redirectUri,
        requestedScope: entry.requestedScope,
        requestedAt: new Date(entry.createdAt),
        expiresAt: new Date(entry.expiresAt),
      };
    },

    // Checked and set with no await, so two approvals of one code cannot
    // both land
    approve: (code, approver, scope, imps) => {
      const entry = requirePending(code, approver);

      if (entry.approval !== null) {
        throw buildConflictError(
          'oauth-approval',
          formatApprovalCode(code),
          'this sign-in is approved already',
        );
      }

      if (!hasScope(entry.requestedScope, scope)) {
        throw new ORPCError('BAD_REQUEST', {
          message: `the client asked for ${entry.requestedScope}; approve that or less`,
        });
      }

      if (!hasScope(approver.scope, scope)) {
        throw buildForbiddenError(
          `token ${approver.name} has ${approver.scope}, so it may approve that or less`,
        );
      }

      const patterns = imps ?? approver.imps;

      if (patterns !== null && !patterns.every((pattern) => isGrantPattern(pattern))) {
        throw new ORPCError('BAD_REQUEST', {
          message: `token ${approver.name}'s patterns are not all an imp name or a prefix and *; name the imps with --imps`,
        });
      }

      if (!isPatternsWithin(patterns, approver.imps)) {
        throw buildForbiddenError(
          `the imps must stay within token ${approver.name}'s: ${(approver.imps ?? []).join(', ')}`,
        );
      }

      pending.set(entry.id, {
        ...entry,
        approval: { tokenId: requireNamedToken(approver), scope, imps: patterns },
      });

      deps.log(
        `impd: oauth: a sign-in for ${entry.client.name} approved by token ${approver.name}`,
      );
    },

    authorize: async (params) => {
      removeStale();

      const client =
        params.clientId === null ? undefined : await findOAuthClientById(deps.db, params.clientId);

      if (client === undefined) {
        return { kind: 'error-page', error: 'unknown_client' };
      }

      const redirectUri = params.redirectUri;

      // matched exactly, and never followed when it is not the client's
      if (redirectUri === null || !client.redirectUris.includes(redirectUri)) {
        return { kind: 'error-page', error: 'bad_redirect_uri' };
      }

      const state = params.state;

      if (params.responseType !== 'code') {
        return buildErrorRedirect(redirectUri, state, 'unsupported_response_type', 'only code');
      }

      if (
        params.codeChallengeMethod !== 'S256' ||
        params.codeChallenge === null ||
        !isChallenge(params.codeChallenge)
      ) {
        return buildErrorRedirect(
          redirectUri,
          state,
          'invalid_request',
          'PKCE with S256 is required',
        );
      }

      if (params.resource !== null && params.resource !== resource) {
        return buildErrorRedirect(
          redirectUri,
          state,
          'invalid_target',
          `the resource is ${resource}`,
        );
      }

      const asked = readScopeList(params.scope);

      if (asked === null) {
        return buildErrorRedirect(
          redirectUri,
          state,
          'invalid_scope',
          'the scopes are read, exec and manage',
        );
      }

      if (!tryAuthorize(client.id)) {
        return { kind: 'too-many', retryS: AUTHORIZE_BUCKET.refillMs / 1000 };
      }

      const at = deps.now();

      const entry: Pending = {
        id: createId(),
        client,
        redirectUri,
        state,
        challenge: params.codeChallenge,
        resource,
        requestedScope: asked.reduce<Scope>(
          (highest, scope) => (hasScope(scope, highest) ? scope : highest),
          'read',
        ),
        approvalCode: createUniqueApprovalCode(byApprovalCode),
        createdAt: at,
        expiresAt: at + APPROVAL_MS,
        approval: null,
      };

      registerPending(entry);

      deps.log(`impd: oauth: ${client.name} asks to sign in; it waits for imp oauth approve`);

      return { kind: 'page', view: toView(entry) };
    },

    // The page's buttons, each bound to its sign-in by the signature:
    // continue shows what was approved, allow issues the code, deny ends it
    finish: (id, signature, action) => {
      removeStale();

      const entry = isSigned(id, signature) ? pending.get(id) : undefined;

      if (entry === undefined) {
        return { kind: 'error-page', error: 'expired' };
      }

      if (action === 'deny') {
        removePending(entry);

        return buildErrorRedirect(
          entry.redirectUri,
          entry.state,
          'access_denied',
          'the sign-in was denied',
        );
      }

      const approval = entry.approval;

      if (approval === null || action === 'continue') {
        return { kind: 'page', view: toView(entry) };
      }

      // spent here, with no await between the check and the spend
      removePending(entry);

      const code = createCode();

      codes.set(code.hash, {
        clientId: entry.client.id,
        redirectUri: entry.redirectUri,
        resource: entry.resource,
        challenge: entry.challenge,
        approval,
        grantId: createId(),
        expiresAt: deps.now() + CODE_MS,
      });

      return {
        kind: 'redirect',
        location: buildRedirect(entry.redirectUri, {
          code: code.text,
          ...(entry.state !== null && { state: entry.state }),
          iss: origin,
        }),
      };
    },

    exchange: async (form) => {
      removeStale();

      const grantType = form.get('grant_type');

      if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
        return buildTokenError(
          400,
          'unsupported_grant_type',
          'authorization_code or refresh_token',
        );
      }

      const client = await requireTokenClient(form);

      if ('status' in client) {
        return client;
      }

      const outcome =
        grantType === 'authorization_code'
          ? await handleCodeExchange(client, form)
          : await handleRefresh(client, form);

      return applyFailureCharge(client.id, outcome);
    },

    // RFC 7009: the token's whole grant goes; an unknown or wrong token is
    // answered the same, and revokes nothing
    revokeToken: async (form) => {
      const client = await requireTokenClient(form);

      if ('status' in client) {
        return client;
      }

      const text = form.get('token') ?? '';
      const access = parseToken('access', text);
      const parsed = access ?? parseToken('refresh', text);

      if (parsed === null) {
        return null;
      }

      const row =
        access === null
          ? await findRefreshToken(deps.db, parsed.id)
          : await findAccessToken(deps.db, parsed.id);

      if (
        row !== undefined &&
        isSameHash(toSecretHash(parsed.secret), row.hash) &&
        row.grant.clientId === client.id
      ) {
        await removeAndRevokeGrant(row.grant.id, 'its client revoked it');
      }

      return null;
    },

    resolveAccess: async (bearer) => {
      const parsed = parseToken('access', bearer);
      const row = parsed === null ? undefined : await findAccessToken(deps.db, parsed.id);
      const at = deps.now();

      if (
        parsed === null ||
        row === undefined ||
        !isSameHash(toSecretHash(parsed.secret), row.hash) ||
        row.expiresAt <= at ||
        row.grant.resource !== resource ||
        deps.revocations.isRevoked(row.grant.id)
      ) {
        return null;
      }

      const grant = row.grant;

      const approver = readApprover({
        tokenId: grant.tokenId,
        scope: grant.scope,
        imps: grant.imps,
      });

      if (approver === null) {
        await removeAndRevokeGrant(grant.id, 'the token that approved it no longer covers it');

        return null;
      }

      if (grant.lastUsedAt === null || at - grant.lastUsedAt.getTime() >= TOUCH_MS) {
        await updateOAuthGrantUse(deps.db, grant.id, at);
      }

      return {
        kind: 'oauth',
        name: `${row.clientName}/${grant.id}`,
        scope: readLowerScope(grant.scope, approver.scope),
        imps: grant.imps,

        // the approver's own list: a grant then meets every refusal its
        // token would, such as no fork; grants of secrets stay refused
        grantable: approver.grantable,
        tokenId: approver.tokenId,
        grantId: grant.id,
        expiresAt: approver.expiresAt,
        principal: `grant:${grant.id}`,
        display: `${row.clientName} via ${approver.display}`,
      };
    },

    removeExpired: async () => {
      removeStale();

      const grantIds = await removeExpiredOAuthRows(deps.db, deps.now());

      for (const grantId of grantIds) {
        deps.revocations.revoke(grantId);
      }
    },
  };
}

// Only a named token approves: root and tailnet identities cannot be removed
// one by one, so a grant from them could not be ended with its approver.
// Returns the token's id.
function requireNamedToken(approver: Readonly<Caller>): string {
  const isNamedKind = approver.kind === 'token' || approver.kind === 'dashboard';

  if (!isNamedKind || approver.tokenId === null || approver.tokenId === ROOT_TOKEN_ID) {
    throw buildForbiddenError(
      'only a named token approves a sign-in; make one with imp token new and use it',
    );
  }

  return approver.tokenId;
}

// the scopes a request lists; null for one that is no scope. None asked is
// read alone.
function readScopeList(text: string | null): Scope[] | null {
  const words = (text ?? '').split(' ').filter((word) => word !== '');

  if (words.length === 0) {
    return ['read'];
  }

  const scopes = words.filter((word): word is Scope => SCOPES.some((scope) => scope === word));

  return scopes.length === words.length ? scopes : null;
}

// the oldest unapproved entry, or the oldest when every one is approved;
// entries come oldest first
function pickEvicted(entries: readonly Readonly<Pending>[]): Readonly<Pending> | undefined {
  return entries.find((entry) => entry.approval === null) ?? entries[0];
}

function createUniqueApprovalCode(taken: ReadonlyMap<string, string>): string {
  for (;;) {
    const code = createApprovalCode();

    if (!taken.has(code)) {
      return code;
    }
  }
}

function buildRedirect(base: string, params: Readonly<Record<string, string>>): string {
  const url = new URL(base);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url.href;
}

function buildTokenError(
  status: 400 | 401 | 429,
  error: string,
  description: string,
): TokenOutcome {
  return { status, body: { error, error_description: description } };
}

function toClient(record: Readonly<OAuthClientRecord>): OAuthClient {
  return {
    name: record.name,
    clientId: record.id,
    redirectUris: record.redirectUris,
    createdAt: record.createdAt,
  };
}
