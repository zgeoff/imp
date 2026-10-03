import { expect, test } from 'bun:test';
import { ApprovalCodeSchema } from '@imp/api';
import type { Scope } from '@imp/api';
import { ORPCError } from '@orpc/server';
import type { Caller } from '../auth/caller';
import { buildTestCaller } from '../auth/test-callers';
import { TEST_TOKEN, setupImpTest } from '../imps/test-imps';
import { ACCESS_TOKEN_MS, REFRESH_TOKEN_MS } from './oauth-service';
import type { AuthorizeOutcome, AuthorizeParams, TokenOutcome } from './oauth-service';

const ORIGIN = 'http://127.0.0.1:7171';
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = 'https://client.example/callback';
const DAY_MS = 24 * 60 * 60 * 1000;

// RFC 7636, appendix B
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

interface SignInOptions {
  readonly clientId?: string;
  readonly requested?: string;
  readonly scope?: Scope;
  readonly imps?: readonly string[];
}

interface Tokens {
  readonly access: string;
  readonly refresh: string;
  readonly scope: string;
}

async function setupTest() {
  // a frozen clock, so a test reaches each expiry to the millisecond
  const harness = await setupImpTest({
    env: { IMP_MCP_PUBLIC_URL: ORIGIN, IMP_MCP_PUBLIC_PORT: '7171' },
    frozenClockMs: Date.now(),
  });

  const oauth = harness.oauth;

  const client = await oauth.addClient('conn', [REDIRECT]);
  const other = await oauth.addClient('other', [REDIRECT]);

  // a named token's caller, as `imp oauth approve` arrives with it
  const createApprover = async (
    name: string,
    scope: Scope = 'manage',
    imps: readonly string[] | null = null,
  ): Promise<Caller> => {
    const made = await harness.tokens.create({ name, scope, imps });

    const caller = harness.tokens.authenticate(made.secret);

    if (caller === null) {
      throw new Error('the new token does not authenticate');
    }

    return caller;
  };

  const startSignIn = (overrides: Readonly<Partial<AuthorizeParams>> = {}) =>
    oauth.authorize({
      responseType: 'code',
      clientId: client.clientId,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      state: 'st',
      scope: 'read exec manage',
      resource: RESOURCE,
      ...overrides,
    });

  // the sign-in up to its code: authorize, approve, allow
  const runSignIn = async (approver: Readonly<Caller>, options: SignInOptions = {}) => {
    const started = await startSignIn({
      clientId: options.clientId ?? client.clientId,
      scope: options.requested ?? 'read exec manage',
    });

    const view = readView(started);

    oauth.approve(
      ApprovalCodeSchema.parse(view.approvalCode),
      approver,
      options.scope ?? 'exec',
      options.imps,
    );

    const done = oauth.finish(view.id, view.signature, 'allow');

    return readRedirect(done).get('code') ?? '';
  };

  const sendCodeExchange = (code: string, fields: Readonly<Record<string, string>> = {}) =>
    oauth.exchange(
      buildForm({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        resource: RESOURCE,
        ...fields,
      }),
    );

  const sendRefresh = (token: string, fields: Readonly<Record<string, string>> = {}) =>
    oauth.exchange(
      buildForm({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: token,
        resource: RESOURCE,
        ...fields,
      }),
    );

  // a whole sign-in, to its first tokens
  const createGrant = async (approver: Readonly<Caller>, options: SignInOptions = {}) => {
    const code = await runSignIn(approver, options);
    const outcome = await sendCodeExchange(code);

    return readTokens(outcome);
  };

  return {
    harness,
    oauth,
    client,
    other,
    createApprover,
    startSignIn,
    runSignIn,
    sendCodeExchange,
    sendRefresh,
    createGrant,
    async [Symbol.asyncDispose]() {
      await harness[Symbol.asyncDispose]();
    },
  };
}

// a form with each empty field left out
function buildForm(fields: Readonly<Record<string, string>>): URLSearchParams {
  return new URLSearchParams(Object.entries(fields).filter(([, value]) => value !== ''));
}

function readView(outcome: Readonly<AuthorizeOutcome>) {
  if (outcome.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${outcome.kind}`);
  }

  return outcome.view;
}

function readRedirect(outcome: Readonly<AuthorizeOutcome>): URLSearchParams {
  if (outcome.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${outcome.kind}`);
  }

  const url = new URL(outcome.location);

  expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);

  return url.searchParams;
}

function readTokens(outcome: Readonly<TokenOutcome>): Tokens {
  if (outcome.status !== 200) {
    throw new Error(`expected tokens, got ${outcome.body.error}`);
  }

  return {
    access: outcome.body.access_token,
    refresh: outcome.body.refresh_token,
    scope: outcome.body.scope,
  };
}

function readError(outcome: Readonly<TokenOutcome>): string {
  return outcome.status === 200 ? 'none' : outcome.body.error;
}

// the message a promise rejects with, or 'none'
async function readRejection(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  return 'none';
}

function readErrorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof ORPCError ? String(error.code) : String(error);
  }

  return 'none';
}

test('a sign-in a named token approves ends in tokens for the scope it gave', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop', 'manage', ['dev-*']);
  const viewOutcome = await ctx.startSignIn();

  const view = readView(viewOutcome);

  expect(view.requestedScope).toBe('manage');
  expect(view.approvalCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  expect(view.approval).toBeNull();

  const code = ApprovalCodeSchema.parse(view.approvalCode);

  expect(ctx.oauth.readApproval(code, approver)).toMatchObject({
    client: 'conn',
    redirectUri: REDIRECT,
    requestedScope: 'manage',
  });

  ctx.oauth.approve(code, approver, 'exec', ['dev-a*']);

  // Continue shows what was approved before Allow issues anything
  const confirmed = readView(ctx.oauth.finish(view.id, view.signature, 'continue'));

  expect(confirmed.approval).toEqual({ scope: 'exec', imps: ['dev-a*'] });

  const params = readRedirect(ctx.oauth.finish(view.id, view.signature, 'allow'));

  expect(params.get('state')).toBe('st');
  expect(params.get('iss')).toBe(ORIGIN);

  const tokensOutcome = await ctx.sendCodeExchange(params.get('code') ?? '');

  const tokens = readTokens(tokensOutcome);

  expect(tokens.scope).toBe('read exec');

  const caller = await ctx.oauth.resolveAccess(tokens.access);

  expect(caller).toMatchObject({
    kind: 'oauth',
    scope: 'exec',
    imps: ['dev-a*'],
    grantable: [],
    tokenId: approver.tokenId,
    display: 'conn via laptop',
  });

  expect(caller?.name).toBe(`conn/${caller?.grantId ?? ''}`);

  const grants = await ctx.oauth.listGrants();

  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ client: 'conn', token: 'laptop', scope: 'exec' });
});

test('an unknown client or a redirect it was not added with gets a page, never a redirect', async () => {
  await using ctx = await setupTest();

  const outcome = await ctx.startSignIn({ clientId: 'impc_guess' });

  expect(outcome).toEqual({
    kind: 'error-page',
    error: 'unknown_client',
  });

  const outcome2 = await ctx.startSignIn({ clientId: null });

  expect(outcome2).toEqual({
    kind: 'error-page',
    error: 'unknown_client',
  });

  for (const redirectUri of [
    null,
    'https://evil.example/callback',
    `${REDIRECT}/`,
    `${REDIRECT}?a=1`,
  ]) {
    const outcome3 = await ctx.startSignIn({ redirectUri });

    expect(outcome3).toEqual({
      kind: 'error-page',
      error: 'bad_redirect_uri',
    });
  }
});

test('every other refused sign-in goes back to the client with the issuer and the state', async () => {
  await using ctx = await setupTest();

  const cases: readonly (readonly [Partial<AuthorizeParams>, string])[] = [
    [{ responseType: 'token' }, 'unsupported_response_type'],
    [{ codeChallenge: null }, 'invalid_request'],
    [{ codeChallengeMethod: 'plain' }, 'invalid_request'],
    [{ codeChallenge: 'short' }, 'invalid_request'],
    [{ resource: 'https://elsewhere.example/mcp' }, 'invalid_target'],
    [{ scope: 'read admin' }, 'invalid_scope'],
  ];

  for (const [overrides, error] of cases) {
    const paramsOutcome = await ctx.startSignIn(overrides);

    const params = readRedirect(paramsOutcome);

    expect(params.get('error')).toBe(error);
    expect(params.get('iss')).toBe(ORIGIN);
    expect(params.get('state')).toBe('st');
  }

  // no state asked, none sent back
  const paramsOutcome = await ctx.startSignIn({ responseType: 'token', state: null });

  const params = readRedirect(paramsOutcome);

  expect(params.has('state')).toBeFalse();
});

test('deny ends the sign-in with access_denied and the issuer', async () => {
  await using ctx = await setupTest();

  const viewOutcome = await ctx.startSignIn();

  const view = readView(viewOutcome);
  const params = readRedirect(ctx.oauth.finish(view.id, view.signature, 'deny'));

  expect(params.get('error')).toBe('access_denied');
  expect(params.get('iss')).toBe(ORIGIN);
  expect(params.get('state')).toBe('st');

  expect(ctx.oauth.finish(view.id, view.signature, 'allow')).toEqual({
    kind: 'error-page',
    error: 'expired',
  });
});

test('a button counts only with its sign-in’s signature, and Allow only after approval', async () => {
  await using ctx = await setupTest();

  const viewOutcome = await ctx.startSignIn();

  const view = readView(viewOutcome);

  const otherOutcome = await ctx.startSignIn();

  const other = readView(otherOutcome);

  expect(ctx.oauth.finish(view.id, other.signature, 'allow')).toEqual({
    kind: 'error-page',
    error: 'expired',
  });

  expect(ctx.oauth.finish(view.id, '', 'deny')).toEqual({ kind: 'error-page', error: 'expired' });

  // unapproved, Allow shows the page again and issues no code
  expect(ctx.oauth.finish(view.id, view.signature, 'allow').kind).toBe('page');
});

test('a sign-in and its approval code end after 10 minutes', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const viewOutcome = await ctx.startSignIn();

  const view = readView(viewOutcome);

  ctx.harness.advance(10 * 60 * 1000);

  const code = ApprovalCodeSchema.parse(view.approvalCode);

  expect(
    readErrorCode(() => {
      ctx.oauth.approve(code, approver, 'read', undefined);
    }),
  ).toBe('NOT_FOUND');

  expect(ctx.oauth.finish(view.id, view.signature, 'continue').kind).toBe('error-page');
});

test('only a named token approves, once, within what was asked and what it holds', async () => {
  await using ctx = await setupTest();

  const viewOutcome = await ctx.startSignIn({ scope: 'read exec' });

  const view = readView(viewOutcome);
  const code = ApprovalCodeSchema.parse(view.approvalCode);
  const root = ctx.harness.tokens.authenticate(TEST_TOKEN);

  if (root === null) {
    throw new Error('no root caller');
  }

  const tailnet = buildTestCaller({ kind: 'tailnet', tokenId: null, name: 'alice@example.com' });
  const ssh = buildTestCaller({ kind: 'ssh' });

  for (const caller of [root, tailnet, ssh]) {
    expect(
      readErrorCode(() => {
        ctx.oauth.approve(code, caller, 'read', undefined);
      }),
    ).toBe('FORBIDDEN');
  }

  const reader = await ctx.createApprover('reader', 'read');
  const narrow = await ctx.createApprover('narrow', 'manage', ['dev-*']);
  const odd = await ctx.createApprover('odd', 'manage', ['*-dev']);
  const manager = await ctx.createApprover('manager', 'manage');

  // past what the client asked for, or what the approver holds
  expect(
    readErrorCode(() => {
      ctx.oauth.approve(code, manager, 'manage', undefined);
    }),
  ).toBe('BAD_REQUEST');

  expect(
    readErrorCode(() => {
      ctx.oauth.approve(code, reader, 'exec', undefined);
    }),
  ).toBe('FORBIDDEN');

  // patterns past the approver's, or past the grant grammar
  expect(
    readErrorCode(() => {
      ctx.oauth.approve(code, narrow, 'exec', ['web']);
    }),
  ).toBe('FORBIDDEN');

  expect(
    readErrorCode(() => {
      ctx.oauth.approve(code, narrow, 'exec', ['dev*']);
    }),
  ).toBe('FORBIDDEN');

  expect(
    readErrorCode(() => {
      ctx.oauth.approve(code, odd, 'exec', undefined);
    }),
  ).toBe('BAD_REQUEST');

  ctx.oauth.approve(code, narrow, 'exec', undefined);

  expect(readView(ctx.oauth.finish(view.id, view.signature, 'continue')).approval).toEqual({
    scope: 'exec',
    imps: ['dev-*'],
  });

  expect(
    readErrorCode(() => {
      ctx.oauth.approve(code, manager, 'read', undefined);
    }),
  ).toBe('CONFLICT');
});

test('approval codes that match nothing are limited to a burst', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');

  const outcomes = new Set<string>();

  for (let index = 0; index < 25; index += 1) {
    outcomes.add(readErrorCode(() => ctx.oauth.readApproval('AAAAAAAA', approver)));
  }

  expect([...outcomes]).toEqual(['NOT_FOUND', 'TOO_MANY_REQUESTS']);
});

test('a flood of sign-ins drops unapproved ones before an approved one', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const viewOutcome = await ctx.startSignIn();

  const view = readView(viewOutcome);

  ctx.oauth.approve(ApprovalCodeSchema.parse(view.approvalCode), approver, 'read', undefined);

  for (let index = 0; index < 5; index += 1) {
    const outcome = await ctx.startSignIn();

    readView(outcome);
  }

  expect(ctx.oauth.finish(view.id, view.signature, 'allow').kind).toBe('redirect');
});

test('a code exchanges only with its client, redirect, verifier and resource', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const code = await ctx.runSignIn(approver);

  const refused: readonly (readonly [Readonly<Record<string, string>>, string])[] = [
    [{ redirect_uri: 'https://client.example/other' }, 'invalid_grant'],
    [{ code_verifier: `${VERIFIER.slice(0, -1)}A` }, 'invalid_grant'],
    [{ client_id: ctx.other.clientId }, 'invalid_grant'],
    [{ client_id: 'impc_guess' }, 'invalid_client'],
    [{ resource: 'https://elsewhere.example/mcp' }, 'invalid_target'],
  ];

  for (const [fields, expected] of refused) {
    const error = await ctx.sendCodeExchange(code, fields);

    expect(readError(error)).toBe(expected);
  }

  // none of those spent it
  const outcome = await ctx.sendCodeExchange(code);

  readTokens(outcome);
});

test('a code ends after 10 minutes', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const code = await ctx.runSignIn(approver);

  ctx.harness.advance(10 * 60 * 1000);

  const error = await ctx.sendCodeExchange(code);

  expect(readError(error)).toBe('invalid_grant');
});

test('a code presented again in full revokes its grant; a partial replay revokes nothing', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const code = await ctx.runSignIn(approver);
  const tokensOutcome = await ctx.sendCodeExchange(code);

  const tokens = readTokens(tokensOutcome);

  for (const fields of [
    { code_verifier: `${VERIFIER.slice(0, -1)}A` },
    { redirect_uri: 'https://client.example/other' },
    { client_id: ctx.other.clientId },
  ]) {
    const error = await ctx.sendCodeExchange(code, fields);

    expect(readError(error)).toBe('invalid_grant');
  }

  const caller = await ctx.oauth.resolveAccess(tokens.access);

  expect(caller).not.toBeNull();

  const error2 = await ctx.sendCodeExchange(code);

  expect(readError(error2)).toBe('invalid_grant');

  const caller2 = await ctx.oauth.resolveAccess(tokens.access);

  expect(caller2).toBeNull();

  const error3 = await ctx.sendRefresh(tokens.refresh);

  expect(readError(error3)).toBe('invalid_grant');

  const grants = await ctx.oauth.listGrants();

  expect(grants).toEqual([]);
});

test('two exchanges of one code at once leave no grant', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const code = await ctx.runSignIn(approver);
  const outcomes = await Promise.all([ctx.sendCodeExchange(code), ctx.sendCodeExchange(code)]);

  for (const outcome of outcomes) {
    if (outcome.status === 200) {
      const caller = await ctx.oauth.resolveAccess(outcome.body.access_token);

      expect(caller).toBeNull();
    }
  }

  expect(outcomes.filter((outcome) => outcome.status === 200).length).toBeLessThanOrEqual(1);

  const grants = await ctx.oauth.listGrants();

  expect(grants).toEqual([]);
});

test('a refresh rotates both tokens and keeps the grant’s scope and resource', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const first = await ctx.createGrant(approver, { scope: 'exec' });

  // a narrower scope asked for still answers with what the grant holds
  const secondOutcome = await ctx.sendRefresh(first.refresh, { scope: 'read' });

  const second = readTokens(secondOutcome);

  expect(second.scope).toBe('read exec');
  expect(second.refresh).not.toBe(first.refresh);
  expect(second.access).not.toBe(first.access);

  const caller = await ctx.oauth.resolveAccess(second.access);

  expect(caller).not.toBeNull();

  const error = await ctx.sendRefresh(second.refresh, { resource: 'https://x.example/mcp' });

  expect(readError(error)).toBe('invalid_target');

  const error2 = await ctx.sendRefresh(second.refresh, { scope: 'manage' });

  expect(readError(error2)).toBe('invalid_scope');

  // with no resource named, the grant's own stays
  const thirdOutcome = await ctx.sendRefresh(second.refresh, { resource: '' });

  const third = readTokens(thirdOutcome);

  const caller2 = await ctx.oauth.resolveAccess(third.access);

  expect(caller2).not.toBeNull();
});

test('a spent refresh token presented by its client revokes the grant', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const first = await ctx.createGrant(approver);
  const secondOutcome = await ctx.sendRefresh(first.refresh);

  const second = readTokens(secondOutcome);

  const error = await ctx.sendRefresh(first.refresh);

  expect(readError(error)).toBe('invalid_grant');

  const caller = await ctx.oauth.resolveAccess(second.access);

  expect(caller).toBeNull();

  const error2 = await ctx.sendRefresh(second.refresh);

  expect(readError(error2)).toBe('invalid_grant');
});

test('a wrong secret, a guessed id or another client revokes nothing', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const first = await ctx.createGrant(approver);
  const secondOutcome = await ctx.sendRefresh(first.refresh);

  const second = readTokens(secondOutcome);
  const [spentId] = first.refresh.split('.');

  const attempts = [
    // the spent token's id with a wrong secret
    `${spentId ?? ''}.${'A'.repeat(43)}`,
    `imprt_guess.${'A'.repeat(43)}`,
    'imprt_',
    first.access,
  ];

  for (const token of attempts) {
    const error = await ctx.sendRefresh(token);

    expect(readError(error)).toBe('invalid_grant');
  }

  // the right tokens from the wrong client
  const error2 = await ctx.sendRefresh(first.refresh, { client_id: ctx.other.clientId });

  expect(readError(error2)).toBe('invalid_grant');

  const error3 = await ctx.sendRefresh(second.refresh, { client_id: ctx.other.clientId });

  expect(readError(error3)).toBe('invalid_grant');

  const caller = await ctx.oauth.resolveAccess(second.access);

  expect(caller).not.toBeNull();

  const outcome = await ctx.sendRefresh(second.refresh);

  readTokens(outcome);
});

test('two refreshes of one token at once: one wins, and the other revokes the grant', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const first = await ctx.createGrant(approver);

  const outcomes = await Promise.all([
    ctx.sendRefresh(first.refresh),
    ctx.sendRefresh(first.refresh),
  ]);

  expect(outcomes.map((outcome) => outcome.status).toSorted((a, b) => a - b)).toEqual([200, 400]);

  for (const outcome of outcomes) {
    if (outcome.status === 200) {
      const caller = await ctx.oauth.resolveAccess(outcome.body.access_token);

      expect(caller).toBeNull();
    }
  }

  const grants = await ctx.oauth.listGrants();

  expect(grants).toEqual([]);
});

test('a refresh racing a revocation leaves nothing that works', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const first = await ctx.createGrant(approver);
  const [grant] = await ctx.oauth.listGrants();

  const [outcome] = await Promise.all([
    ctx.sendRefresh(first.refresh),
    ctx.oauth.removeGrant(grant?.id ?? ''),
  ]);

  if (outcome.status === 200) {
    const caller = await ctx.oauth.resolveAccess(outcome.body.access_token);

    expect(caller).toBeNull();

    const error = await ctx.sendRefresh(outcome.body.refresh_token);

    expect(readError(error)).toBe('invalid_grant');
  }

  const caller2 = await ctx.oauth.resolveAccess(first.access);

  expect(caller2).toBeNull();

  const grants = await ctx.oauth.listGrants();

  expect(grants).toEqual([]);
  expect(ctx.harness.revocations.isRevoked(grant?.id ?? '')).toBeTrue();
});

test('two grants from one token stay apart until the token goes', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop', 'manage', ['dev-*']);
  const a = await ctx.createGrant(approver, { scope: 'read', imps: ['dev-a'] });
  const b = await ctx.createGrant(approver, { scope: 'exec', imps: ['dev-b'] });
  const callerA = await ctx.oauth.resolveAccess(a.access);
  const callerB = await ctx.oauth.resolveAccess(b.access);

  expect(callerA).toMatchObject({ scope: 'read', imps: ['dev-a'] });
  expect(callerB).toMatchObject({ scope: 'exec', imps: ['dev-b'] });
  expect(callerA?.grantId).not.toBe(callerB?.grantId);
  expect(callerA?.principal).not.toBe(callerB?.principal);

  // a replay on one grant ends that grant alone
  const outcome = await ctx.sendRefresh(a.refresh);

  readTokens(outcome);

  const error = await ctx.sendRefresh(a.refresh);

  expect(readError(error)).toBe('invalid_grant');

  const caller = await ctx.oauth.resolveAccess(b.access);

  expect(caller).not.toBeNull();

  const c = await ctx.createGrant(approver);

  await ctx.oauth.removeGrant(callerB?.grantId ?? '');

  const caller2 = await ctx.oauth.resolveAccess(b.access);

  expect(caller2).toBeNull();

  const caller3 = await ctx.oauth.resolveAccess(c.access);

  expect(caller3).not.toBeNull();

  await ctx.harness.tokens.remove('laptop');

  const caller4 = await ctx.oauth.resolveAccess(c.access);

  expect(caller4).toBeNull();

  const error2 = await ctx.sendRefresh(c.refresh);

  expect(readError(error2)).toBe('invalid_grant');

  const grants = await ctx.oauth.listGrants();

  expect(grants).toEqual([]);
});

test('a grant acts with the lower of its scope and its token’s', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop', 'exec', ['dev-*']);
  const tokens = await ctx.createGrant(approver, { scope: 'read', requested: 'read' });
  const caller = await ctx.oauth.resolveAccess(tokens.access);

  expect(caller).toMatchObject({
    scope: 'read',
    imps: ['dev-*'],
    expiresAt: null,
  });
});

test('an access token lasts 15 minutes', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const tokens = await ctx.createGrant(approver);

  ctx.harness.advance(ACCESS_TOKEN_MS - 1);

  const caller = await ctx.oauth.resolveAccess(tokens.access);

  expect(caller).not.toBeNull();

  ctx.harness.advance(1);

  const caller2 = await ctx.oauth.resolveAccess(tokens.access);

  expect(caller2).toBeNull();

  const caller3 = await ctx.oauth.resolveAccess('imp_not-an-oauth-token');

  expect(caller3).toBeNull();
});

test('a grant ends after 30 days with no refresh, however old it is', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const kept = await ctx.createGrant(approver);
  const lapsed = await ctx.createGrant(approver);
  const lapsedCaller = await ctx.oauth.resolveAccess(lapsed.access);

  ctx.harness.advance(20 * DAY_MS);

  const renewedOutcome = await ctx.sendRefresh(kept.refresh);

  const renewed = readTokens(renewedOutcome);

  ctx.harness.advance(REFRESH_TOKEN_MS - 20 * DAY_MS + 1);

  await ctx.oauth.removeExpired();

  const grants = await ctx.oauth.listGrants();

  expect(grants).toHaveLength(1);
  expect(ctx.harness.revocations.isRevoked(lapsedCaller?.grantId ?? '')).toBeTrue();

  const error = await ctx.sendRefresh(lapsed.refresh);

  expect(readError(error)).toBe('invalid_grant');

  const outcome = await ctx.sendRefresh(renewed.refresh);

  readTokens(outcome);
});

test('revocation by the client ends the grant only with its own valid token', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const tokens = await ctx.createGrant(approver);

  const sendRevoke = (fields: Readonly<Record<string, string>>) =>
    ctx.oauth.revokeToken(new URLSearchParams({ client_id: ctx.client.clientId, ...fields }));

  const revoked = await sendRevoke({ token: `${tokens.access.split('.')[0] ?? ''}.wrong` });

  expect(revoked).toBeNull();

  const revoked2 = await sendRevoke({ token: 'impat_guess.wrong' });

  expect(revoked2).toBeNull();

  const revoked3 = await sendRevoke({ token: tokens.refresh, client_id: ctx.other.clientId });

  expect(revoked3).toBeNull();

  const caller = await ctx.oauth.resolveAccess(tokens.access);

  expect(caller).not.toBeNull();

  const revoked4 = await sendRevoke({ token: tokens.refresh });

  expect(revoked4).toBeNull();

  const caller2 = await ctx.oauth.resolveAccess(tokens.access);

  expect(caller2).toBeNull();
});

test('removing a client ends its grants and its sign-ins', async () => {
  await using ctx = await setupTest();

  const approver = await ctx.createApprover('laptop');
  const tokens = await ctx.createGrant(approver);
  const viewOutcome = await ctx.startSignIn();

  const view = readView(viewOutcome);

  await ctx.oauth.removeClient('conn');

  const caller = await ctx.oauth.resolveAccess(tokens.access);

  expect(caller).toBeNull();
  expect(ctx.oauth.finish(view.id, view.signature, 'continue').kind).toBe('error-page');

  const clients = await ctx.oauth.listClients();

  expect(clients.map((client) => client.name)).toEqual(['other']);
});

test('clients are added once and their redirect URIs change in place', async () => {
  await using ctx = await setupTest();

  const duplicate = await readRejection(ctx.oauth.addClient('conn', [REDIRECT]));

  expect(duplicate).toContain('already exists');

  const updated = await ctx.oauth.updateClient('conn', ['http://127.0.0.1:9000/cb']);

  expect(updated).toMatchObject({
    clientId: ctx.client.clientId,
    redirectUris: ['http://127.0.0.1:9000/cb'],
  });

  const outcome = await ctx.startSignIn();

  expect(outcome).toEqual({ kind: 'error-page', error: 'bad_redirect_uri' });

  const unknownClient = await readRejection(ctx.oauth.updateClient('nope', [REDIRECT]));
  const unknownGrant = await readRejection(ctx.oauth.removeGrant('nope'));

  expect(unknownClient).toContain('not found');
  expect(unknownGrant).toContain('not found');
});
