import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { ApprovalCodeSchema } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { createRevocations } from '../auth/revocations';
import { ROOT_TOKEN_ID, loadTokenStore } from '../auth/token-store';
import { createSecret } from '../db/secrets';
import { buildMockCaller } from '../test-utils/build-mock-caller';
import { createTestDatabase } from '../test-utils/create-test-database';
import { ACCESS_TOKEN_MS, REFRESH_TOKEN_MS, createOAuthService } from './oauth-service';
import type { AuthorizeOutcome } from './oauth-service';

// The verifier and challenge of RFC 7636 appendix B stand for a client's
// PKCE pair throughout: dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk and
// E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM.

async function setupTest() {
  const database = await createTestDatabase();

  // a frozen clock, so a test reaches each expiry to the millisecond
  const startMs = Date.UTC(2026, 0, 1);
  const clock = { nowMs: startMs };
  const readNow = () => clock.nowMs;
  const revocations = createRevocations();

  // the store needs a root token; no test signs in with it
  const tokens = await loadTokenStore({
    db: database.db,
    rootToken: 'root-secret',
    now: readNow,
    onRemove: revocations.revoke,
    isFileKey: () => false,
  });

  // the public route on loopback, as IMP_MCP_PUBLIC_URL names it in tests
  const origin = 'http://127.0.0.1:7171';

  const oauth = createOAuthService({
    db: database.db,
    tokens,
    revocations,
    config: { origin, host: '127.0.0.1:7171', port: 7171 },
    now: readNow,
    log: () => {},
    key: randomBytes(32),
  });

  return {
    db: database.db,
    tokens,
    revocations,
    oauth,
    startMs,
    origin,
    advance: (ms: number) => {
      clock.nowMs += ms;
    },
  };
}

test('#createOAuthService serves the resource under its issuer, the public route’s origin', async () => {
  const ctx = await setupTest();

  expect(ctx.oauth.issuer).toBe(ctx.origin);
  expect(ctx.oauth.resource).toBe(`${ctx.origin}/mcp`);
});

test('#createOAuthService falls back to a loopback issuer with the public route off', async () => {
  const ctx = await setupTest();

  const oauth = createOAuthService({
    db: ctx.db,
    tokens: ctx.tokens,
    revocations: ctx.revocations,
    config: null,
    now: Date.now,
    log: () => {},
    key: randomBytes(32),
  });

  expect(oauth.issuer).toBe('http://127.0.0.1');
});

test('#authorize shows the sign-in page, waiting for its approval code', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const outcome = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  expect(outcome).toStrictEqual({
    kind: 'page',
    view: {
      id: expect.toBeString(),
      signature: expect.toBeString(),
      clientName: 'conn',
      redirectUri: 'https://client.example/callback',
      requestedScope: 'manage',
      approvalCode: expect.toBeString(),
      expiresAt: ctx.startMs + 10 * 60 * 1000,
      approval: null,
    },
  });
});

test('#authorize shows an approval code of two groups of 4 symbols', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const outcome = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: null,
    resource: null,
  });

  if (outcome.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${outcome.kind}`);
  }

  expect(outcome.view.approvalCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

test('#authorize takes no scope asked as read', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const outcome = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: null,
    scope: null,
    resource: null,
  });

  if (outcome.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${outcome.kind}`);
  }

  expect(outcome.view.requestedScope).toBe('read');
});

test.each([['impc_guess'], [null]])(
  '#authorize shows an error page, never a redirect, for the client id %p',
  async (clientId) => {
    const ctx = await setupTest();

    await ctx.oauth.addClient('conn', ['https://client.example/callback']);

    const outcome = await ctx.oauth.authorize({
      responseType: 'code',
      clientId,
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      state: 'st',
      scope: null,
      resource: null,
    });

    expect(outcome).toStrictEqual({ kind: 'error-page', error: 'unknown_client' });
  },
);

test.each([
  [null],
  ['https://evil.example/callback'],
  ['https://client.example/callback/'],
  ['https://client.example/callback?a=1'],
])(
  '#authorize shows an error page, never a redirect, for the redirect URI %p',
  async (redirectUri) => {
    const ctx = await setupTest();
    const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

    const outcome = await ctx.oauth.authorize({
      responseType: 'code',
      clientId: client.clientId,
      redirectUri,
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      state: 'st',
      scope: null,
      resource: null,
    });

    expect(outcome).toStrictEqual({ kind: 'error-page', error: 'bad_redirect_uri' });
  },
);

test.each([
  ['responseType', 'token', 'unsupported_response_type', 'only code'],
  ['codeChallenge', null, 'invalid_request', 'PKCE with S256 is required'],
  ['codeChallengeMethod', 'plain', 'invalid_request', 'PKCE with S256 is required'],
  ['codeChallenge', 'short', 'invalid_request', 'PKCE with S256 is required'],
  ['scope', 'read admin', 'invalid_scope', 'the scopes are read, exec and manage'],
] as const)(
  '#authorize sends a sign-in with %s %p back to the client as %s, with the issuer and state',
  async (field, value, error, description) => {
    const ctx = await setupTest();
    const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

    const outcome = await ctx.oauth.authorize({
      responseType: 'code',
      clientId: client.clientId,
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      state: 'st',
      scope: null,
      resource: null,
      [field]: value,
    });

    const location = new URL('https://client.example/callback');

    location.search = new URLSearchParams({
      error,
      error_description: description,
      state: 'st',
      iss: ctx.origin,
    }).toString();

    expect(outcome).toStrictEqual({ kind: 'redirect', location: location.href });
  },
);

test('#authorize sends a sign-in for another resource back to the client as invalid_target, with the issuer and state', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const outcome = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: null,
    resource: 'https://elsewhere.example/mcp',
  });

  const location = new URL('https://client.example/callback');

  location.search = new URLSearchParams({
    error: 'invalid_target',
    error_description: `the resource is ${ctx.origin}/mcp`,
    state: 'st',
    iss: ctx.origin,
  }).toString();

  expect(outcome).toStrictEqual({ kind: 'redirect', location: location.href });
});

test('#authorize sends no state back when the client sent none', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const outcome = await ctx.oauth.authorize({
    responseType: 'token',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: null,
    scope: null,
    resource: null,
  });

  if (outcome.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${outcome.kind}`);
  }

  expect(new URL(outcome.location).searchParams.has('state')).toBeFalse();
});

test('#authorize holds back a client past 10 sign-ins in a burst', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  // the burst of 10 sign-ins this client may start at once
  for (let index = 0; index < 10; index += 1) {
    await ctx.oauth.authorize({
      responseType: 'code',
      clientId: client.clientId,
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      state: null,
      scope: null,
      resource: null,
    });
  }

  const outcome = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: null,
    scope: null,
    resource: null,
  });

  expect(outcome).toStrictEqual({ kind: 'too-many', retryS: 6 });
});

test('#authorize keeps a client’s approved sign-in while newer ones push out its unapproved ones', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: null,
    scope: null,
    resource: null,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  invariant(approver);

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'read',
    undefined,
  );

  // five more of its own, past the 3 it may hold
  for (let index = 0; index < 5; index += 1) {
    await ctx.oauth.authorize({
      responseType: 'code',
      clientId: client.clientId,
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      state: null,
      scope: null,
      resource: null,
    });
  }

  expect(ctx.oauth.finish(started.view.id, started.view.signature, 'allow').kind).toBe('redirect');
});

test('#authorize keeps a waiting sign-in through a flood under other clients', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const waiting = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: null,
    scope: null,
    resource: null,
  });

  if (waiting.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${waiting.kind}`);
  }

  const flooders = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      ctx.oauth.addClient(`flood-${String(index)}`, ['https://client.example/callback']),
    ),
  );

  // 4 sign-ins from each flooder, one after another
  for (const flooder of flooders) {
    for (let index = 0; index < 4; index += 1) {
      await ctx.oauth.authorize({
        responseType: 'code',
        clientId: flooder.clientId,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        codeChallengeMethod: 'S256',
        state: null,
        scope: null,
        resource: null,
      });
    }
  }

  const still = ctx.oauth.finish(waiting.view.id, waiting.view.signature, 'continue');

  expect(still).toStrictEqual({ kind: 'page', view: waiting.view });
});

test('#authorize holds back sign-ins for 10 minutes once 16 are waiting', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const waiting = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: null,
    scope: null,
    resource: null,
  });

  if (waiting.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${waiting.kind}`);
  }

  const flooders = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      ctx.oauth.addClient(`flood-${String(index)}`, ['https://client.example/callback']),
    ),
  );

  const outcomes: AuthorizeOutcome[] = [];

  // 4 sign-ins from each flooder, one after another: 3 each fit, until the
  // 16 places are taken
  for (const flooder of flooders) {
    for (let index = 0; index < 4; index += 1) {
      const outcome = await ctx.oauth.authorize({
        responseType: 'code',
        clientId: flooder.clientId,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        codeChallengeMethod: 'S256',
        state: null,
        scope: null,
        resource: null,
      });

      outcomes.push(outcome);
    }
  }

  expect(outcomes.map((outcome) => outcome.kind)).toStrictEqual([
    ...Array.from({ length: 20 }, () => 'page' as const),
    ...Array.from({ length: 4 }, () => 'too-many' as const),
  ]);

  expect(outcomes.slice(20)).toStrictEqual(
    Array.from({ length: 4 }, () => ({ kind: 'too-many', retryS: 600 })),
  );
});

test('#readApproval shows the approver what the sign-in asks for', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: null,
    scope: 'read exec',
    resource: null,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  invariant(approver);

  expect(
    ctx.oauth.readApproval(ApprovalCodeSchema.parse(started.view.approvalCode), approver),
  ).toStrictEqual({
    client: 'conn',
    redirectUri: 'https://client.example/callback',
    requestedScope: 'exec',
    requestedAt: new Date(ctx.startMs),
    expiresAt: new Date(ctx.startMs + 10 * 60 * 1000),
  });
});

test('#readApproval refuses a code that matches no sign-in', async () => {
  const ctx = await setupTest();
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  expect(() => ctx.oauth.readApproval('AAAAAAAA', approver)).toThrow(
    expect.objectContaining({ code: 'NOT_FOUND', message: 'oauth-approval AAAA-AAAA not found' }),
  );
});

test('#readApproval holds back a token past 20 codes that match nothing', async () => {
  const ctx = await setupTest();
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  // the burst of 20 misses a token may make, each refused as not found
  await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      Promise.try(() => ctx.oauth.readApproval('AAAAAAAA', approver)),
    ),
  );

  expect(() => ctx.oauth.readApproval('AAAAAAAA', approver)).toThrow(
    expect.objectContaining({
      code: 'TOO_MANY_REQUESTS',
      message: 'too many codes that match no sign-in; wait a few seconds',
    }),
  );
});

test('#readApproval keeps each token’s burst of misses its own', async () => {
  const ctx = await setupTest();
  const firstMade = await ctx.tokens.create({ name: 'first', scope: 'manage', imps: null });

  const first = ctx.tokens.authenticate(firstMade.secret);

  invariant(first);

  const secondMade = await ctx.tokens.create({ name: 'second', scope: 'manage', imps: null });

  const second = ctx.tokens.authenticate(secondMade.secret);

  invariant(second);

  // the first token spends its whole burst of 20 misses, and one more
  await Promise.allSettled(
    Array.from({ length: 21 }, () => Promise.try(() => ctx.oauth.readApproval('AAAAAAAA', first))),
  );

  expect(() => ctx.oauth.readApproval('AAAAAAAA', second)).toThrow(
    expect.objectContaining({ code: 'NOT_FOUND', message: 'oauth-approval AAAA-AAAA not found' }),
  );
});

test('#approve sets what the approver gives, which Continue then shows', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const approverMade = await ctx.tokens.create({
    name: 'laptop',
    scope: 'manage',
    imps: ['dev-*'],
  });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(ApprovalCodeSchema.parse(started.view.approvalCode), approver, 'exec', [
    'dev-a*',
  ]);

  const confirmed = ctx.oauth.finish(started.view.id, started.view.signature, 'continue');

  expect(confirmed).toStrictEqual({
    kind: 'page',
    view: { ...started.view, approval: { scope: 'exec', imps: ['dev-a*'] } },
  });
});

test('#approve gives the sign-in the approver’s own patterns when none are named', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const approverMade = await ctx.tokens.create({
    name: 'laptop',
    scope: 'manage',
    imps: ['dev-*'],
  });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const confirmed = ctx.oauth.finish(started.view.id, started.view.signature, 'continue');

  if (confirmed.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${confirmed.kind}`);
  }

  expect(confirmed.view.approval).toStrictEqual({ scope: 'exec', imps: ['dev-*'] });
});

test.each([
  ['the root token', { kind: 'token', tokenId: ROOT_TOKEN_ID, name: 'root' }],
  ['a tailnet identity', { kind: 'tailnet', tokenId: null, name: 'alice@example.com' }],
  ['an ssh key', { kind: 'ssh', name: 'me@laptop' }],
  ['an OAuth grant', { kind: 'oauth', name: 'conn/grant-a' }],
] as const)('#approve refuses %s, which is no named token', async (_what, overrides) => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  expect(() => {
    ctx.oauth.approve(
      ApprovalCodeSchema.parse(started.view.approvalCode),
      buildMockCaller(overrides),
      'read',
      undefined,
    );
  }).toThrow(
    expect.objectContaining({
      code: 'FORBIDDEN',
      message: 'only a named token approves a sign-in; make one with imp token new and use it',
    }),
  );
});

test('#approve refuses a scope above what the client asked for', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  expect(() => {
    ctx.oauth.approve(
      ApprovalCodeSchema.parse(started.view.approvalCode),
      approver,
      'manage',
      undefined,
    );
  }).toThrow(
    expect.objectContaining({
      code: 'BAD_REQUEST',
      message: 'the client asked for exec; approve that or less',
    }),
  );
});

test('#approve refuses a scope above the approver’s own', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'reader', scope: 'read', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  expect(() => {
    ctx.oauth.approve(
      ApprovalCodeSchema.parse(started.view.approvalCode),
      approver,
      'exec',
      undefined,
    );
  }).toThrow(
    expect.objectContaining({
      code: 'FORBIDDEN',
      message: 'token reader has read, so it may approve that or less',
    }),
  );
});

test.each([[['web']], [['dev*']]])(
  '#approve refuses the patterns %p past the approver’s dev-*',
  async (imps) => {
    const ctx = await setupTest();
    const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

    const approverMade = await ctx.tokens.create({
      name: 'narrow',
      scope: 'manage',
      imps: ['dev-*'],
    });

    const approver = ctx.tokens.authenticate(approverMade.secret);

    invariant(approver);

    const started = await ctx.oauth.authorize({
      responseType: 'code',
      clientId: client.clientId,
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      state: 'st',
      scope: 'read exec manage',
      resource: ctx.oauth.resource,
    });

    if (started.kind !== 'page') {
      throw new Error(`expected the sign-in page, got ${started.kind}`);
    }

    expect(() => {
      ctx.oauth.approve(
        ApprovalCodeSchema.parse(started.view.approvalCode),
        approver,
        'exec',
        imps,
      );
    }).toThrow(
      expect.objectContaining({
        code: 'FORBIDDEN',
        message: "the imps must stay within token narrow's: dev-*",
      }),
    );
  },
);

test('#approve refuses an approver’s own patterns that are no grant pattern', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'odd', scope: 'manage', imps: ['*-dev'] });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  expect(() => {
    ctx.oauth.approve(
      ApprovalCodeSchema.parse(started.view.approvalCode),
      approver,
      'exec',
      undefined,
    );
  }).toThrow(
    expect.objectContaining({
      code: 'BAD_REQUEST',
      message:
        "token odd's patterns are not all an imp name or a prefix and *; name the imps with --imps",
    }),
  );
});

test('#approve refuses a sign-in approved already', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  expect(() => {
    ctx.oauth.approve(
      ApprovalCodeSchema.parse(started.view.approvalCode),
      approver,
      'read',
      undefined,
    );
  }).toThrow(
    expect.objectContaining({ code: 'CONFLICT', message: 'this sign-in is approved already' }),
  );
});

test('#approve refuses a sign-in whose 10 minutes ran out', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.advance(10 * 60 * 1000);

  expect(() => {
    ctx.oauth.approve(
      ApprovalCodeSchema.parse(started.view.approvalCode),
      approver,
      'read',
      undefined,
    );
  }).toThrow(
    expect.objectContaining({
      code: 'NOT_FOUND',
      message: `oauth-approval ${started.view.approvalCode} not found`,
    }),
  );
});

test('#finish ends a sign-in whose 10 minutes ran out', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.advance(10 * 60 * 1000);

  expect(ctx.oauth.finish(started.view.id, started.view.signature, 'continue')).toStrictEqual({
    kind: 'error-page',
    error: 'expired',
  });
});

test('#finish sends Allow back to the client with a code, the state and the issuer', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const location = new URL(allowed.location);

  expect({
    at: `${location.origin}${location.pathname}`,
    params: Object.fromEntries(location.searchParams),
  }).toStrictEqual({
    at: 'https://client.example/callback',
    params: { code: expect.toBeString(), state: 'st', iss: ctx.origin },
  });
});

test('#finish shows the page again for Allow before the approval, and issues no code', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  const outcome = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  expect(outcome).toStrictEqual({ kind: 'page', view: started.view });
});

test('#finish sends Deny back to the client as access_denied, with the issuer', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  const denied = ctx.oauth.finish(started.view.id, started.view.signature, 'deny');

  const location = new URL('https://client.example/callback');

  location.search = new URLSearchParams({
    error: 'access_denied',
    error_description: 'the sign-in was denied',
    state: 'st',
    iss: ctx.origin,
  }).toString();

  expect(denied).toStrictEqual({ kind: 'redirect', location: location.href });
});

test('#finish ends a denied sign-in', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.finish(started.view.id, started.view.signature, 'deny');

  expect(ctx.oauth.finish(started.view.id, started.view.signature, 'allow')).toStrictEqual({
    kind: 'error-page',
    error: 'expired',
  });
});

test('#finish refuses a button with another sign-in’s signature', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  const otherstarted = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (otherstarted.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${otherstarted.kind}`);
  }

  expect(ctx.oauth.finish(started.view.id, otherstarted.view.signature, 'allow')).toStrictEqual({
    kind: 'error-page',
    error: 'expired',
  });
});

test('#finish refuses a button with no signature', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  expect(ctx.oauth.finish(started.view.id, '', 'deny')).toStrictEqual({
    kind: 'error-page',
    error: 'expired',
  });
});

test('#exchange gives tokens for the scope the approver gave', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const approverMade = await ctx.tokens.create({
    name: 'laptop',
    scope: 'manage',
    imps: ['dev-*'],
  });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(ApprovalCodeSchema.parse(started.view.approvalCode), approver, 'exec', [
    'dev-a*',
  ]);

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  expect(exchanged).toStrictEqual({
    status: 200,
    body: {
      access_token: expect.toStartWith('impat_'),
      token_type: 'Bearer',
      expires_in: 900,
      refresh_token: expect.toStartWith('imprt_'),
      scope: 'read exec',
    },
  });
});

test.each([
  [
    'redirect_uri',
    'https://client.example/other',
    400,
    'invalid_grant',
    'the code is not valid for this request',
  ],
  [
    'code_verifier',
    'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXA',
    400,
    'invalid_grant',
    'the code is not valid for this request',
  ],
  ['client_id', 'impc_guess', 401, 'invalid_client', 'no such client'],
] as const)(
  '#exchange refuses a code presented with %s %p as %p %s',
  async (field, value, status, error, description) => {
    const ctx = await setupTest();
    const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
    const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

    const approver = ctx.tokens.authenticate(approverMade.secret);

    invariant(approver);

    const started = await ctx.oauth.authorize({
      responseType: 'code',
      clientId: client.clientId,
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      state: 'st',
      scope: 'read exec manage',
      resource: ctx.oauth.resource,
    });

    if (started.kind !== 'page') {
      throw new Error(`expected the sign-in page, got ${started.kind}`);
    }

    ctx.oauth.approve(
      ApprovalCodeSchema.parse(started.view.approvalCode),
      approver,
      'exec',
      undefined,
    );

    const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

    if (allowed.kind !== 'redirect') {
      throw new Error(`expected a redirect, got ${allowed.kind}`);
    }

    const code = new URL(allowed.location).searchParams.get('code') ?? '';

    const fields = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    });

    fields.set(field, value);

    const outcome = await ctx.oauth.exchange(fields);

    expect(outcome).toStrictEqual({ status, body: { error, error_description: description } });
  },
);

test('#exchange refuses a code presented for another resource as 400 invalid_target', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const fields = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: client.clientId,
    code,
    redirect_uri: 'https://client.example/callback',
    code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  });

  fields.set('resource', 'https://elsewhere.example/mcp');

  const outcome = await ctx.oauth.exchange(fields);

  expect(outcome).toStrictEqual({
    status: 400,
    body: { error: 'invalid_target', error_description: `the resource is ${ctx.origin}/mcp` },
  });
});

test('#exchange refuses a code presented by another client', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const other = await ctx.oauth.addClient('other', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const fields = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: client.clientId,
    code,
    redirect_uri: 'https://client.example/callback',
    code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  });

  fields.set('client_id', other.clientId);

  const outcome = await ctx.oauth.exchange(fields);

  expect(outcome).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the code is not valid for this request' },
  });
});

test('#exchange still takes a code after five refusals that did not spend it', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const other = await ctx.oauth.addClient('other', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const byRedirect = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/other',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  const byVerifier = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXA',
    }),
  );

  const byOtherClient = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: other.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  const byUnknownClient = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'impc_guess',
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  const byResource = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      resource: 'https://elsewhere.example/mcp',
    }),
  );

  const outcome = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  expect(byRedirect.body).toMatchObject({ error: 'invalid_grant' });
  expect(byVerifier.body).toMatchObject({ error: 'invalid_grant' });
  expect(byOtherClient.body).toMatchObject({ error: 'invalid_grant' });
  expect(byUnknownClient.body).toMatchObject({ error: 'invalid_client' });
  expect(byResource.body).toMatchObject({ error: 'invalid_target' });
  expect(outcome.status).toBe(200);
});

test('#exchange refuses a code after 10 minutes', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  ctx.advance(10 * 60 * 1000);

  const outcome = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  expect(outcome).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the code is not valid' },
  });
});

test('#exchange refuses a code whose approving token was removed after Allow', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  await ctx.tokens.remove('laptop');

  const outcome = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  expect(outcome).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the token that approved it is gone' },
  });
});

test('#exchange refuses a grant type other than a code or a refresh', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const outcome = await ctx.oauth.exchange(
    new URLSearchParams({ grant_type: 'client_credentials', client_id: client.clientId }),
  );

  expect(outcome).toStrictEqual({
    status: 400,
    body: {
      error: 'unsupported_grant_type',
      error_description: 'authorization_code or refresh_token',
    },
  });
});

test('#exchange refuses a code presented again in full and revokes its grant', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const replayed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  const refreshedAfter = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: exchanged.body.refresh_token,
    }),
  );

  expect(replayed).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the code is not valid' },
  });

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toBeNull();

  expect(refreshedAfter).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the refresh token is not valid' },
  });

  const grants = await ctx.oauth.listGrants();

  expect(grants).toStrictEqual([]);
});

test('#exchange revokes nothing for a code presented again with another verifier, redirect or client', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const other = await ctx.oauth.addClient('other', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const byVerifier = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXA',
    }),
  );

  const byRedirect = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/other',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  const byOtherClient = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: other.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(byVerifier).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the code is not valid' },
  });

  expect(byRedirect).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the code is not valid' },
  });

  expect(byOtherClient).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the code is not valid' },
  });

  expect(caller?.kind).toBe('oauth');
});

test('#exchange refuses both of two exchanges of one code at once, and keeps no grant', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const outcomes = await Promise.all([
    ctx.oauth.exchange(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        code,
        redirect_uri: 'https://client.example/callback',
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      }),
    ),
    ctx.oauth.exchange(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        code,
        redirect_uri: 'https://client.example/callback',
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      }),
    ),
  ]);

  expect(outcomes).toStrictEqual([
    { status: 400, body: { error: 'invalid_grant', error_description: 'the code is not valid' } },
    { status: 400, body: { error: 'invalid_grant', error_description: 'the code is not valid' } },
  ]);

  const grants = await ctx.oauth.listGrants();

  expect(grants).toStrictEqual([]);
});

test('#exchange refreshes both tokens and keeps the grant’s scope, though a narrower one is asked', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const refreshed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: exchanged.body.refresh_token,
      scope: 'read',
    }),
  );

  if (refreshed.status !== 200) {
    throw new Error(`expected tokens, got ${refreshed.body.error}`);
  }

  expect(refreshed.body.scope).toBe('read exec');
  expect(refreshed.body.access_token).not.toBe(exchanged.body.access_token);
  expect(refreshed.body.refresh_token).not.toBe(exchanged.body.refresh_token);
});

test('#exchange ends a grant on refresh once its token no longer covers it, as for a stored grant wider than its token', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const approverMade = await ctx.tokens.create({
    name: 'laptop',
    scope: 'manage',
    imps: ['dev-*'],
  });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(ApprovalCodeSchema.parse(started.view.approvalCode), approver, 'exec', [
    'dev-*',
  ]);

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: new URL(allowed.location).searchParams.get('code') ?? '',
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  // a grant row for every imp, past the token's dev-* patterns
  await ctx.db.updateTable('oauth_grants').set({ imps: null }).execute();

  const refreshed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: exchanged.body.refresh_token,
    }),
  );

  const grants = await ctx.db.selectFrom('oauth_grants').selectAll().execute();

  expect(refreshed).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the grant ended' },
  });

  expect(grants).toStrictEqual([]);
});

test('#exchange gives a refreshed access token that works, with no resource named', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const refreshed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: exchanged.body.refresh_token,
    }),
  );

  if (refreshed.status !== 200) {
    throw new Error(`expected tokens, got ${refreshed.body.error}`);
  }

  const caller = await ctx.oauth.resolveAccess(refreshed.body.access_token);

  expect(caller?.kind).toBe('oauth');
});

test.each([
  ['scope', 'manage', 'invalid_scope', 'the grant holds read exec'],
  ['scope', 'root', 'invalid_scope', 'the grant holds read exec'],
] as const)(
  '#exchange refuses a refresh with %s %p as %s',
  async (field, value, error, description) => {
    const ctx = await setupTest();
    const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
    const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

    const approver = ctx.tokens.authenticate(approverMade.secret);

    invariant(approver);

    const started = await ctx.oauth.authorize({
      responseType: 'code',
      clientId: client.clientId,
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      state: 'st',
      scope: 'read exec manage',
      resource: ctx.oauth.resource,
    });

    if (started.kind !== 'page') {
      throw new Error(`expected the sign-in page, got ${started.kind}`);
    }

    ctx.oauth.approve(
      ApprovalCodeSchema.parse(started.view.approvalCode),
      approver,
      'exec',
      undefined,
    );

    const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

    if (allowed.kind !== 'redirect') {
      throw new Error(`expected a redirect, got ${allowed.kind}`);
    }

    const code = new URL(allowed.location).searchParams.get('code') ?? '';

    const exchanged = await ctx.oauth.exchange(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        code,
        redirect_uri: 'https://client.example/callback',
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      }),
    );

    if (exchanged.status !== 200) {
      throw new Error(`expected tokens, got ${exchanged.body.error}`);
    }

    const outcome = await ctx.oauth.exchange(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: exchanged.body.refresh_token,
        [field]: value,
      }),
    );

    expect(outcome).toStrictEqual({ status: 400, body: { error, error_description: description } });
  },
);

test('#exchange refuses a refresh for another resource as invalid_target', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const outcome = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: exchanged.body.refresh_token,
      resource: 'https://x.example/mcp',
    }),
  );

  expect(outcome).toStrictEqual({
    status: 400,
    body: { error: 'invalid_target', error_description: `the resource is ${ctx.origin}/mcp` },
  });
});

test('#exchange revokes the grant when its client presents a spent refresh token', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const refreshed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: exchanged.body.refresh_token,
    }),
  );

  if (refreshed.status !== 200) {
    throw new Error(`expected tokens, got ${refreshed.body.error}`);
  }

  const replayed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: exchanged.body.refresh_token,
    }),
  );

  const refreshedAfter = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: refreshed.body.refresh_token,
    }),
  );

  expect(replayed).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the refresh token was used already' },
  });

  const refreshedCaller = await ctx.oauth.resolveAccess(refreshed.body.access_token);

  expect(refreshedCaller).toBeNull();

  expect(refreshedAfter).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the refresh token is not valid' },
  });
});

test.each([
  ['a guessed id', 'imprt_guess.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['an empty token', 'imprt_'],
])('#exchange revokes nothing for a refresh with %s', async (_what, given) => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const outcome = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: given,
    }),
  );

  expect(outcome).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the refresh token is not valid' },
  });

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toMatchObject({
    kind: 'oauth',
  });
});

test('#exchange revokes nothing for a refresh with the spent token’s id and a wrong secret', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const refreshed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: exchanged.body.refresh_token,
    }),
  );

  if (refreshed.status !== 200) {
    throw new Error(`expected tokens, got ${refreshed.body.error}`);
  }

  const [spentId] = exchanged.body.refresh_token.split('.');

  const outcome = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: `${String(spentId)}.${'A'.repeat(43)}`,
    }),
  );

  const caller = await ctx.oauth.resolveAccess(refreshed.body.access_token);
  const [listed] = await ctx.oauth.listGrants();

  invariant(listed);

  expect(outcome).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the refresh token is not valid' },
  });

  expect(caller).toStrictEqual({
    kind: 'oauth',
    name: `conn/${listed.id}`,
    scope: 'exec',
    imps: null,
    grantable: [],
    tokenId: approver.tokenId,
    grantId: listed.id,
    expiresAt: null,
    principal: `grant:${listed.id}`,
    display: 'conn via laptop',
  });
});

test('#exchange revokes nothing for a refresh with the access token', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const outcome = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: exchanged.body.access_token,
    }),
  );

  expect(outcome).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the refresh token is not valid' },
  });

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toMatchObject({
    kind: 'oauth',
  });
});

test('#exchange revokes nothing for a refresh from another client', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const other = await ctx.oauth.addClient('other', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const outcome = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: other.clientId,
      refresh_token: exchanged.body.refresh_token,
    }),
  );

  expect(outcome).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the refresh token is not valid' },
  });

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toMatchObject({
    kind: 'oauth',
  });
});

test('#exchange revokes nothing for a spent refresh token presented by another client', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const other = await ctx.oauth.addClient('other', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const refreshed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: exchanged.body.refresh_token,
    }),
  );

  if (refreshed.status !== 200) {
    throw new Error(`expected tokens, got ${refreshed.body.error}`);
  }

  const outcome = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: other.clientId,
      refresh_token: exchanged.body.refresh_token,
    }),
  );

  const refreshedAgain = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: refreshed.body.refresh_token,
    }),
  );

  expect(outcome).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the refresh token is not valid' },
  });

  expect(refreshedAgain.status).toBe(200);
});

test('#exchange lets one of two refreshes of a token at once win, and the other revokes the grant', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const outcomes = await Promise.all([
    ctx.oauth.exchange(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: exchanged.body.refresh_token,
      }),
    ),
    ctx.oauth.exchange(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: exchanged.body.refresh_token,
      }),
    ),
  ]);

  const won = outcomes.find((outcome) => outcome.status === 200);

  if (won?.status !== 200) {
    throw new Error('expected one refresh to win');
  }

  expect(outcomes).toIncludeSameMembers([
    won,
    {
      status: 400,
      body: { error: 'invalid_grant', error_description: 'the refresh token was used already' },
    },
  ]);

  const wonCaller = await ctx.oauth.resolveAccess(won.body.access_token);

  expect(wonCaller).toBeNull();

  const grants = await ctx.oauth.listGrants();

  expect(grants).toStrictEqual([]);
});

test('#exchange refuses a refresh that races a revocation, and leaves nothing that works', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const [listed] = await ctx.oauth.listGrants();

  invariant(listed);

  const [outcome] = await Promise.all([
    ctx.oauth.exchange(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: exchanged.body.refresh_token,
      }),
    ),
    ctx.oauth.removeGrant(listed.id),
  ]);

  expect(outcome).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the refresh token is not valid' },
  });

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toBeNull();

  const grants = await ctx.oauth.listGrants();

  expect(grants).toStrictEqual([]);
  expect(ctx.revocations.isRevoked(listed.id)).toBeTrue();
});

test('#exchange answers slow_down to a client past its 30 failed token requests', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  // the burst of 30 failures a client may make
  for (let index = 0; index < 30; index += 1) {
    await ctx.oauth.exchange(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: `imprt_guess.${String(index)}`,
      }),
    );
  }

  const failed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: 'imprt_guess.again',
    }),
  );

  expect(failed).toStrictEqual({
    status: 429,
    body: {
      error: 'slow_down',
      error_description: 'too many failed token requests from this client',
    },
  });
});

test('#exchange takes a valid refresh from a client past its failed token requests', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  // the burst of 30 failures a client may make
  for (let index = 0; index < 30; index += 1) {
    await ctx.oauth.exchange(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: `imprt_guess.${String(index)}`,
      }),
    );
  }

  const failed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: 'imprt_guess.again',
    }),
  );

  const refreshed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: exchanged.body.refresh_token,
    }),
  );

  expect(failed.status).toBe(429);
  expect(refreshed.status).toBe(200);
});

test('#resolveAccess gives the grant’s caller, acting for its client through the approver', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const approverMade = await ctx.tokens.create({
    name: 'laptop',
    scope: 'manage',
    imps: ['dev-*'],
  });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(ApprovalCodeSchema.parse(started.view.approvalCode), approver, 'exec', [
    'dev-a*',
  ]);

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);
  const [listed] = await ctx.oauth.listGrants();

  invariant(listed);

  expect(caller).toStrictEqual({
    kind: 'oauth',
    name: `conn/${listed.id}`,
    scope: 'exec',
    imps: ['dev-a*'],
    grantable: [],
    tokenId: approver.tokenId,
    grantId: listed.id,
    expiresAt: null,
    principal: `grant:${listed.id}`,
    display: 'conn via laptop',
  });
});

test('#resolveAccess gives a grant the lower of its scope and its token’s, with its token’s patterns', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'exec', imps: ['dev-*'] });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'read',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller?.scope).toBe('read');
  expect(caller?.imps).toStrictEqual(['dev-*']);
  expect(caller?.expiresAt).toBeNull();
});

test('#resolveAccess gives a grant its token’s grantable list', async () => {
  const ctx = await setupTest();

  await createSecret(ctx.db, { name: 'gh', kind: 'github', rules: [], valueFile: 'gh' });

  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const approverMade = await ctx.tokens.create({
    name: 'granter',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller?.grantable).toStrictEqual([{ name: 'gh', generation: expect.toBeString() }]);
  expect(caller?.grantable).toStrictEqual(approver.grantable);
});

test('#resolveAccess keeps two grants from one token apart', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const approverMade = await ctx.tokens.create({
    name: 'laptop',
    scope: 'manage',
    imps: ['dev-*'],
  });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const astarted = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (astarted.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${astarted.kind}`);
  }

  ctx.oauth.approve(ApprovalCodeSchema.parse(astarted.view.approvalCode), approver, 'read', [
    'dev-a',
  ]);

  const aallowed = ctx.oauth.finish(astarted.view.id, astarted.view.signature, 'allow');

  if (aallowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${aallowed.kind}`);
  }

  const acode = new URL(aallowed.location).searchParams.get('code') ?? '';

  const aexchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: acode,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (aexchanged.status !== 200) {
    throw new Error(`expected tokens, got ${aexchanged.body.error}`);
  }

  const bstarted = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (bstarted.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${bstarted.kind}`);
  }

  ctx.oauth.approve(ApprovalCodeSchema.parse(bstarted.view.approvalCode), approver, 'exec', [
    'dev-b',
  ]);

  const ballowed = ctx.oauth.finish(bstarted.view.id, bstarted.view.signature, 'allow');

  if (ballowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${ballowed.kind}`);
  }

  const bcode = new URL(ballowed.location).searchParams.get('code') ?? '';

  const bexchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: bcode,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (bexchanged.status !== 200) {
    throw new Error(`expected tokens, got ${bexchanged.body.error}`);
  }

  const [first, second] = await Promise.all([
    ctx.oauth.resolveAccess(aexchanged.body.access_token),
    ctx.oauth.resolveAccess(bexchanged.body.access_token),
  ]);

  invariant(first);
  invariant(second);

  expect(first).toMatchObject({ scope: 'read', imps: ['dev-a'] });
  expect(second).toMatchObject({ scope: 'exec', imps: ['dev-b'] });
  expect(first.grantId).not.toBe(second.grantId);
  expect(first.principal).not.toBe(second.principal);
});

test('#resolveAccess ends one grant alone when a replay revokes it', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const approverMade = await ctx.tokens.create({
    name: 'laptop',
    scope: 'manage',
    imps: ['dev-*'],
  });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const astarted = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (astarted.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${astarted.kind}`);
  }

  ctx.oauth.approve(ApprovalCodeSchema.parse(astarted.view.approvalCode), approver, 'exec', [
    'dev-a',
  ]);

  const aallowed = ctx.oauth.finish(astarted.view.id, astarted.view.signature, 'allow');

  if (aallowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${aallowed.kind}`);
  }

  const acode = new URL(aallowed.location).searchParams.get('code') ?? '';

  const aexchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: acode,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (aexchanged.status !== 200) {
    throw new Error(`expected tokens, got ${aexchanged.body.error}`);
  }

  const bstarted = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (bstarted.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${bstarted.kind}`);
  }

  ctx.oauth.approve(ApprovalCodeSchema.parse(bstarted.view.approvalCode), approver, 'exec', [
    'dev-b',
  ]);

  const ballowed = ctx.oauth.finish(bstarted.view.id, bstarted.view.signature, 'allow');

  if (ballowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${ballowed.kind}`);
  }

  const bcode = new URL(ballowed.location).searchParams.get('code') ?? '';

  const bexchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: bcode,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (bexchanged.status !== 200) {
    throw new Error(`expected tokens, got ${bexchanged.body.error}`);
  }

  const refreshed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: aexchanged.body.refresh_token,
    }),
  );

  const replayed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: aexchanged.body.refresh_token,
    }),
  );

  const aexchangedCaller = await ctx.oauth.resolveAccess(aexchanged.body.access_token);

  expect(refreshed.status).toBe(200);

  expect(replayed).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the refresh token was used already' },
  });

  expect(aexchangedCaller).toBeNull();

  const bexchangedCaller = await ctx.oauth.resolveAccess(bexchanged.body.access_token);

  expect(bexchangedCaller).toMatchObject({
    imps: ['dev-b'],
  });
});

test('#resolveAccess ends every grant of a removed token, and revokes each by its id', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const astarted = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (astarted.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${astarted.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(astarted.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const aallowed = ctx.oauth.finish(astarted.view.id, astarted.view.signature, 'allow');

  if (aallowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${aallowed.kind}`);
  }

  const acode = new URL(aallowed.location).searchParams.get('code') ?? '';

  const aexchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: acode,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (aexchanged.status !== 200) {
    throw new Error(`expected tokens, got ${aexchanged.body.error}`);
  }

  const bstarted = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (bstarted.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${bstarted.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(bstarted.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const ballowed = ctx.oauth.finish(bstarted.view.id, bstarted.view.signature, 'allow');

  if (ballowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${ballowed.kind}`);
  }

  const bcode = new URL(ballowed.location).searchParams.get('code') ?? '';

  const bexchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: bcode,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (bexchanged.status !== 200) {
    throw new Error(`expected tokens, got ${bexchanged.body.error}`);
  }

  const listed = await ctx.oauth.listGrants();

  await ctx.tokens.remove('laptop');

  const refreshed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: aexchanged.body.refresh_token,
    }),
  );

  const aexchangedCaller = await ctx.oauth.resolveAccess(aexchanged.body.access_token);

  expect(aexchangedCaller).toBeNull();

  const bexchangedCaller = await ctx.oauth.resolveAccess(bexchanged.body.access_token);

  expect(bexchangedCaller).toBeNull();

  const grants = await ctx.oauth.listGrants();

  expect(grants).toStrictEqual([]);

  expect(refreshed).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the refresh token is not valid' },
  });

  expect(listed.map((each) => ctx.revocations.isRevoked(each.id))).toStrictEqual([true, true]);
});

test('#resolveAccess takes an access token for 15 minutes less a millisecond', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  ctx.advance(ACCESS_TOKEN_MS - 1);

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller?.kind).toBe('oauth');
});

test('#resolveAccess refuses an access token after 15 minutes', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  ctx.advance(ACCESS_TOKEN_MS);

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toBeNull();
});

test.each([['imp_not-an-oauth-token'], ['impat_guess.wrong'], ['']])(
  '#resolveAccess refuses %p, which is no access token',
  async (bearer) => {
    const ctx = await setupTest();
    const caller = await ctx.oauth.resolveAccess(bearer);

    expect(caller).toBeNull();
  },
);

test('#resolveAccess refuses an access token whose grant was revoked', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const [listed] = await ctx.oauth.listGrants();

  invariant(listed);

  ctx.revocations.revoke(listed.id);

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toBeNull();
});

test('#resolveAccess writes a grant’s last use', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  ctx.advance(30_000);

  await ctx.oauth.resolveAccess(exchanged.body.access_token);

  const [listed] = await ctx.oauth.listGrants();

  expect(listed?.lastUsedAt).toStrictEqual(new Date(ctx.startMs + 30_000));
});

test('#resolveAccess writes a grant’s last use at most once a minute', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  await ctx.oauth.resolveAccess(exchanged.body.access_token);

  ctx.advance(59_000);

  await ctx.oauth.resolveAccess(exchanged.body.access_token);

  const [listed] = await ctx.oauth.listGrants();

  expect(listed?.lastUsedAt).toStrictEqual(new Date(ctx.startMs));
});

test('#removeExpired ends a grant with no refresh for 30 days, and keeps one refreshed within them', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const keptstarted = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (keptstarted.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${keptstarted.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(keptstarted.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const keptallowed = ctx.oauth.finish(keptstarted.view.id, keptstarted.view.signature, 'allow');

  if (keptallowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${keptallowed.kind}`);
  }

  const keptcode = new URL(keptallowed.location).searchParams.get('code') ?? '';

  const keptexchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: keptcode,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (keptexchanged.status !== 200) {
    throw new Error(`expected tokens, got ${keptexchanged.body.error}`);
  }

  const lapsedstarted = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (lapsedstarted.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${lapsedstarted.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(lapsedstarted.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const lapsedallowed = ctx.oauth.finish(
    lapsedstarted.view.id,
    lapsedstarted.view.signature,
    'allow',
  );

  if (lapsedallowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${lapsedallowed.kind}`);
  }

  const lapsedcode = new URL(lapsedallowed.location).searchParams.get('code') ?? '';

  const lapsedexchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: lapsedcode,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (lapsedexchanged.status !== 200) {
    throw new Error(`expected tokens, got ${lapsedexchanged.body.error}`);
  }

  const keptCaller = await ctx.oauth.resolveAccess(keptexchanged.body.access_token);
  const lapsedCaller = await ctx.oauth.resolveAccess(lapsedexchanged.body.access_token);

  invariant(keptCaller?.grantId);
  invariant(lapsedCaller?.grantId);

  ctx.advance(20 * 24 * 60 * 60 * 1000);

  const renewed = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: keptexchanged.body.refresh_token,
    }),
  );

  if (renewed.status !== 200) {
    throw new Error(`expected tokens, got ${renewed.body.error}`);
  }

  ctx.advance(REFRESH_TOKEN_MS - 20 * 24 * 60 * 60 * 1000 + 1);

  await ctx.oauth.removeExpired();

  const grants = await ctx.oauth.listGrants();

  const lapsedRefresh = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: lapsedexchanged.body.refresh_token,
    }),
  );

  const keptRefresh = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: renewed.body.refresh_token,
    }),
  );

  expect(grants.map((grant) => grant.id)).toStrictEqual([keptCaller.grantId]);
  expect(ctx.revocations.isRevoked(lapsedCaller.grantId)).toBeTrue();

  expect(lapsedRefresh).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'the refresh token is not valid' },
  });

  expect(keptRefresh.status).toBe(200);
});

test('#revokeToken ends the grant of its client’s own refresh token', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const outcome = await ctx.oauth.revokeToken(
    new URLSearchParams({ client_id: client.clientId, token: exchanged.body.refresh_token }),
  );

  expect(outcome).toBeNull();

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toBeNull();
});

test('#revokeToken ends the grant of its client’s own access token', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  await ctx.oauth.revokeToken(
    new URLSearchParams({ client_id: client.clientId, token: exchanged.body.access_token }),
  );

  const grants = await ctx.oauth.listGrants();

  expect(grants).toStrictEqual([]);
});

test('#revokeToken answers an access token’s id with a wrong secret as it answers a revocation, and revokes nothing', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const [accessId] = exchanged.body.access_token.split('.');

  const outcome = await ctx.oauth.revokeToken(
    new URLSearchParams({ client_id: client.clientId, token: `${String(accessId)}.wrong` }),
  );

  expect(outcome).toBeNull();

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toMatchObject({
    kind: 'oauth',
  });
});

test('#revokeToken answers a guessed token as it answers a revocation, and revokes nothing', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const outcome = await ctx.oauth.revokeToken(
    new URLSearchParams({ client_id: client.clientId, token: 'impat_guess.wrong' }),
  );

  expect(outcome).toBeNull();

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toMatchObject({
    kind: 'oauth',
  });
});

test('#revokeToken answers no token at all as it answers a revocation, and revokes nothing', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const outcome = await ctx.oauth.revokeToken(new URLSearchParams({ client_id: client.clientId }));

  expect(outcome).toBeNull();

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toMatchObject({
    kind: 'oauth',
  });
});

test('#revokeToken answers another client’s token as it answers a revocation, and revokes nothing', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const other = await ctx.oauth.addClient('other', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const outcome = await ctx.oauth.revokeToken(
    new URLSearchParams({ client_id: other.clientId, token: exchanged.body.refresh_token }),
  );

  expect(outcome).toBeNull();

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toMatchObject({
    kind: 'oauth',
  });
});

test('#revokeToken refuses a client it does not know', async () => {
  const ctx = await setupTest();

  const outcome = await ctx.oauth.revokeToken(
    new URLSearchParams({ client_id: 'impc_guess', token: 'impat_guess.wrong' }),
  );

  expect(outcome).toStrictEqual({
    status: 401,
    body: { error: 'invalid_client', error_description: 'no such client' },
  });
});

test('#listGrants names each grant’s client and token', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const grants = await ctx.oauth.listGrants();

  expect(grants).toStrictEqual([
    {
      id: expect.toBeString(),
      client: 'conn',
      token: 'laptop',
      scope: 'exec',
      imps: null,
      createdAt: new Date(ctx.startMs),
      lastUsedAt: null,
    },
  ]);
});

test('#addClient adds a public client with its redirect URIs', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  expect(client).toStrictEqual({
    name: 'conn',
    clientId: expect.toStartWith('impc_'),
    redirectUris: ['https://client.example/callback'],
    createdAt: new Date(ctx.startMs),
  });
});

test('#addClient refuses a name a client has', async () => {
  const ctx = await setupTest();

  await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  expect(ctx.oauth.addClient('conn', ['https://client.example/callback'])).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'oauth-client conn already exists',
  });
});

test('#listClients lists every client', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const other = await ctx.oauth.addClient('other', ['https://client.example/callback']);
  const clients = await ctx.oauth.listClients();

  expect(clients).toIncludeSameMembers([client, other]);
});

test('#updateClient changes a client’s redirect URIs in place', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const updated = await ctx.oauth.updateClient('conn', ['http://127.0.0.1:9000/cb']);

  expect(updated).toStrictEqual({ ...client, redirectUris: ['http://127.0.0.1:9000/cb'] });
});

test('#updateClient makes a client’s old redirect URI one it was not added with', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  await ctx.oauth.updateClient('conn', ['http://127.0.0.1:9000/cb']);

  const outcome = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: null,
    scope: null,
    resource: null,
  });

  expect(outcome).toStrictEqual({ kind: 'error-page', error: 'bad_redirect_uri' });
});

test('#updateClient refuses a name no client has', async () => {
  const ctx = await setupTest();

  expect(ctx.oauth.updateClient('nope', ['https://client.example/callback'])).rejects.toMatchObject(
    {
      code: 'NOT_FOUND',
      message: 'oauth-client nope not found',
    },
  );
});

test('#removeClient removes the client with its grants and its sign-ins, and keeps another client', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const other = await ctx.oauth.addClient('other', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const waitingstarted = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (waitingstarted.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${waitingstarted.kind}`);
  }

  await ctx.oauth.removeClient('conn');

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toBeNull();

  expect(
    ctx.oauth.finish(waitingstarted.view.id, waitingstarted.view.signature, 'continue'),
  ).toStrictEqual({ kind: 'error-page', error: 'expired' });

  const clients = await ctx.oauth.listClients();

  expect(clients).toStrictEqual([other]);
});

test('#removeClient ends a code it issued before the exchange', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  await ctx.oauth.removeClient('conn');

  const outcome = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  expect(outcome).toStrictEqual({
    status: 401,
    body: { error: 'invalid_client', error_description: 'no such client' },
  });
});

test('#removeClient refuses a name no client has', async () => {
  const ctx = await setupTest();

  expect(ctx.oauth.removeClient('nope')).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'oauth-client nope not found',
  });
});

test('#removeGrant ends the grant and revokes it', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);
  const approverMade = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const started = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (started.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${started.kind}`);
  }

  ctx.oauth.approve(
    ApprovalCodeSchema.parse(started.view.approvalCode),
    approver,
    'exec',
    undefined,
  );

  const allowed = ctx.oauth.finish(started.view.id, started.view.signature, 'allow');

  if (allowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${allowed.kind}`);
  }

  const code = new URL(allowed.location).searchParams.get('code') ?? '';

  const exchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (exchanged.status !== 200) {
    throw new Error(`expected tokens, got ${exchanged.body.error}`);
  }

  const [listed] = await ctx.oauth.listGrants();

  invariant(listed);

  await ctx.oauth.removeGrant(listed.id);

  const caller = await ctx.oauth.resolveAccess(exchanged.body.access_token);

  expect(caller).toBeNull();
  expect(ctx.revocations.isRevoked(listed.id)).toBeTrue();
});

test('#removeGrant leaves another grant of the same token working', async () => {
  const ctx = await setupTest();
  const client = await ctx.oauth.addClient('conn', ['https://client.example/callback']);

  const approverMade = await ctx.tokens.create({
    name: 'laptop',
    scope: 'manage',
    imps: ['dev-*'],
  });

  const approver = ctx.tokens.authenticate(approverMade.secret);

  invariant(approver);

  const astarted = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (astarted.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${astarted.kind}`);
  }

  ctx.oauth.approve(ApprovalCodeSchema.parse(astarted.view.approvalCode), approver, 'read', [
    'dev-a',
  ]);

  const aallowed = ctx.oauth.finish(astarted.view.id, astarted.view.signature, 'allow');

  if (aallowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${aallowed.kind}`);
  }

  const acode = new URL(aallowed.location).searchParams.get('code') ?? '';

  const aexchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: acode,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (aexchanged.status !== 200) {
    throw new Error(`expected tokens, got ${aexchanged.body.error}`);
  }

  const bstarted = await ctx.oauth.authorize({
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    state: 'st',
    scope: 'read exec manage',
    resource: ctx.oauth.resource,
  });

  if (bstarted.kind !== 'page') {
    throw new Error(`expected the sign-in page, got ${bstarted.kind}`);
  }

  ctx.oauth.approve(ApprovalCodeSchema.parse(bstarted.view.approvalCode), approver, 'exec', [
    'dev-b',
  ]);

  const ballowed = ctx.oauth.finish(bstarted.view.id, bstarted.view.signature, 'allow');

  if (ballowed.kind !== 'redirect') {
    throw new Error(`expected a redirect, got ${ballowed.kind}`);
  }

  const bcode = new URL(ballowed.location).searchParams.get('code') ?? '';

  const bexchanged = await ctx.oauth.exchange(
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: bcode,
      redirect_uri: 'https://client.example/callback',
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }),
  );

  if (bexchanged.status !== 200) {
    throw new Error(`expected tokens, got ${bexchanged.body.error}`);
  }

  const removed = await ctx.oauth.resolveAccess(aexchanged.body.access_token);

  invariant(removed?.grantId);

  await ctx.oauth.removeGrant(removed.grantId);

  const removedCaller = await ctx.oauth.resolveAccess(aexchanged.body.access_token);
  const sibling = await ctx.oauth.resolveAccess(bexchanged.body.access_token);

  expect(removedCaller).toBeNull();
  expect(sibling).toMatchObject({ kind: 'oauth', scope: 'exec', imps: ['dev-b'] });
});

test('#removeGrant refuses an id no grant has', async () => {
  const ctx = await setupTest();

  expect(ctx.oauth.removeGrant('nope')).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'oauth-grant nope not found',
  });
});
