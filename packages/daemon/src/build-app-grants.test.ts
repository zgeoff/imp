import { expect, spyOn, test } from 'bun:test';
import type { ImpContract, Scope } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadTokenStore } from './auth/token-store';
import { listApiCalls } from './db/api-audit';
import { TEST_TOKEN, buildTestApp, setupImpTest } from './imps/test-imps';

// Scoped tokens that may grant selected secrets (docs/guides/tokens.md#granting-secrets),
// through the API as a client calls it.

const ORIGIN = 'http://impd.test';
const VALUE = 'sk-synthetic-126-0123456789abcdef';

interface RequestHandler {
  readonly handle: (request: Request) => Promise<Response>;
}

interface TokenOptions {
  readonly scope?: Scope;
  readonly imps?: readonly string[];
  readonly grantable?: readonly string[];
}

type Client = ContractRouterClient<ImpContract>;

function buildClient(app: RequestHandler, headers: Readonly<Record<string, string>>): Client {
  const link = new RPCLink({
    url: `${ORIGIN}/rpc`,
    headers,
    fetch: (request) => app.handle(request),
  });

  return createORPCClient(link);
}

async function setupTest() {
  const harness = await setupImpTest();

  const root = buildTestApp(harness, harness);

  await harness.createTestImage('base');
  await root.client.imps.create({ name: 'dev-a' });
  await root.client.imps.create({ name: 'prod' });
  await root.client.secrets.add({ name: 'gh', kind: 'github', value: VALUE });
  await root.client.secrets.add({ name: 'npm', kind: 'npm', value: VALUE });

  // a manage token for dev-* that may grant gh
  const createToken = async (name: string, options: TokenOptions = {}) => {
    const made = await root.client.tokens.create({
      name,
      scope: options.scope ?? 'manage',
      imps: [...(options.imps ?? ['dev-*'])],
      ...(options.grantable !== undefined && { grantable: [...options.grantable] }),
    });

    return {
      secret: made.secret,
      client: buildClient(root.app, { authorization: `Bearer ${made.secret}` }),
    };
  };

  // the token's dashboard session, as a browser on impd's page sends it
  const createSession = async (secret: string, app: RequestHandler = root.app): Promise<Client> => {
    const response = await app.handle(
      new Request(`${ORIGIN}/auth/login`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ token: secret }),
      }),
    );

    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';

    expect(cookie).toStartWith('imp_session=');

    return buildClient(app, { cookie, 'sec-fetch-site': 'same-origin' });
  };

  // impd restarted on the same database: a new imp service, token store and app
  const startAgain = async () => {
    const tokens = await loadTokenStore({
      db: harness.db,
      rootToken: TEST_TOKEN,
      now: harness.now,
      onRemove: harness.revocations.revoke,
      isFileKey: () => false,
    });

    return buildTestApp({ ...harness, tokens }, harness.restartImpd());
  };

  return { ...harness, ...root, createToken, createSession, startAgain };
}

// the code and reason of a failed call, or 'ok'
async function readFailure(call: Promise<unknown>): Promise<string> {
  try {
    await call;

    return 'ok';
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
      return 'thrown';
    }

    const data: unknown = 'data' in error ? error.data : undefined;

    const reason: unknown =
      typeof data === 'object' && data !== null && 'reason' in data ? data.reason : undefined;

    return typeof reason === 'string' ? `${String(error.code)} ${reason}` : String(error.code);
  }
}

test('a token may grant and revoke a listed secret on its imps, and nothing past either', async () => {
  await using ctx = await setupTest();

  const agent = await ctx.createToken('agent', { grantable: ['gh'] });

  const outcomes: string[] = [];

  for (const name of ['dev-a', 'prod']) {
    for (const secret of ['gh', 'npm']) {
      const added = await readFailure(agent.client.grants.add({ name, secret }));

      outcomes.push(`add ${name} ${secret}: ${added}`);
    }
  }

  // the root token grants everything, so each delete finds a grant
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });
  await ctx.client.grants.add({ name: 'prod', secret: 'gh' });
  await ctx.client.grants.add({ name: 'prod', secret: 'npm' });

  const listed = await agent.client.grants.list({ name: 'dev-a' });

  for (const name of ['dev-a', 'prod']) {
    for (const secret of ['gh', 'npm']) {
      const removed = await readFailure(agent.client.grants.delete({ name, secret }));

      outcomes.push(`delete ${name} ${secret}: ${removed}`);
    }
  }

  expect(outcomes).toEqual([
    'add dev-a gh: ok',
    'add dev-a npm: FORBIDDEN not_grantable',
    'add prod gh: FORBIDDEN imp_out_of_scope',
    'add prod npm: FORBIDDEN imp_out_of_scope',
    'delete dev-a gh: ok',
    'delete dev-a npm: FORBIDDEN not_grantable',
    'delete prod gh: FORBIDDEN imp_out_of_scope',
    'delete prod npm: FORBIDDEN imp_out_of_scope',
  ]);

  const left = await Promise.all([
    ctx.client.grants.list({ name: 'dev-a' }),
    ctx.client.grants.list({ name: 'prod' }),
  ]);

  expect(listed).toEqual(['gh', 'npm']);
  expect(left).toEqual([['npm'], ['gh', 'npm']]);
});

test('a grant is refused without manage, without a list, and for a secret it cannot name', async () => {
  await using ctx = await setupTest();

  const agent = await ctx.createToken('agent', { grantable: ['gh'] });
  const plain = await ctx.createToken('plain');
  const reader = await ctx.createToken('reader', { scope: 'exec' });

  const outcomes = await Promise.all([
    readFailure(reader.client.grants.add({ name: 'dev-a', secret: 'gh' })),
    readFailure(plain.client.grants.add({ name: 'dev-a', secret: 'gh' })),

    // checked before any lookup: an unknown secret is refused, not missing
    readFailure(agent.client.grants.add({ name: 'dev-a', secret: 'nope' })),
    readFailure(agent.client.grants.add({ name: 'dev-a', secret: 'Not A Name' })),
    readFailure(agent.client.grants.delete({ name: 'dev-a', secret: 'nope' })),

    // past the check, the usual errors
    readFailure(agent.client.grants.add({ name: 'dev-gone', secret: 'gh' })),
    readFailure(agent.client.grants.delete({ name: 'dev-a', secret: 'gh' })),
  ]);

  expect(outcomes).toEqual([
    'FORBIDDEN scope',
    'FORBIDDEN not_grantable',
    'FORBIDDEN not_grantable',
    'FORBIDDEN not_grantable',
    'FORBIDDEN not_grantable',
    'NOT_FOUND',
    'NOT_FOUND',
  ]);
});

test('tokens.create takes a list only with manage and imps, of secrets that exist', async () => {
  await using ctx = await setupTest();

  const create = (
    scope: Scope,
    imps: readonly string[] | undefined,
    grantable: readonly string[],
  ) =>
    readFailure(
      ctx.client.tokens.create({
        name: 'agent',
        scope,
        ...(imps !== undefined && { imps: [...imps] }),
        grantable: [...grantable],
      }),
    );

  const outcomes = await Promise.all([
    create('exec', ['dev-*'], ['gh']),
    create('manage', undefined, ['gh']),
    create('manage', ['dev-*'], []),
    create('manage', ['dev-*'], ['gh', 'gh']),
    create('manage', ['dev-*'], ['Not A Name']),
    create(
      'manage',
      ['dev-*'],
      Array.from({ length: 33 }, (_, index) => `s${String(index)}`),
    ),
    create('manage', ['dev-*'], ['gh', 'nope']),
  ]);

  expect(outcomes).toEqual([
    'BAD_REQUEST',
    'BAD_REQUEST',
    'BAD_REQUEST',
    'BAD_REQUEST',
    'BAD_REQUEST',
    'BAD_REQUEST',
    'NOT_FOUND',
  ]);

  const none = await ctx.client.tokens.list();

  expect(none).toEqual([]);

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh', 'npm'],
  });

  expect(made.token.grantable).toEqual(['gh', 'npm']);

  const agent = buildClient(ctx.app, { authorization: `Bearer ${made.secret}` });

  const identity = await agent.tokens.whoami();

  expect(identity).toEqual({
    kind: 'token',
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh', 'npm'],
  });
});

test('a dashboard session made with the token has the same authority, no more', async () => {
  await using ctx = await setupTest();

  const agent = await ctx.createToken('agent', { grantable: ['gh'] });
  const browser = await ctx.createSession(agent.secret);

  const outcomes = await Promise.all([
    readFailure(browser.grants.add({ name: 'dev-a', secret: 'gh' })),
    readFailure(browser.grants.add({ name: 'dev-a', secret: 'npm' })),
    readFailure(browser.grants.add({ name: 'prod', secret: 'gh' })),
    readFailure(browser.imps.fork({ source: 'dev-a', name: 'dev-b' })),
  ]);

  expect(outcomes).toEqual([
    'ok',
    'FORBIDDEN not_grantable',
    'FORBIDDEN imp_out_of_scope',
    'FORBIDDEN',
  ]);

  const identity = await browser.tokens.whoami();

  expect(identity.grantable).toEqual(['gh']);
});

test('a token that may grant forks and moves nothing, and leaves nothing behind', async () => {
  await using ctx = await setupTest();

  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });

  const agent = await ctx.createToken('agent', { grantable: ['gh'] });
  const plain = await ctx.createToken('plain');

  const outcomes = await Promise.all([
    readFailure(agent.client.imps.fork({ source: 'dev-a', name: 'dev-b' })),
    readFailure(agent.client.moves.prepare({ name: 'dev-a' })),
    readFailure(
      agent.client.moves.send({ name: 'dev-a', to: 'https://other.example.com', ticket: 't' }),
    ),
    readFailure(agent.client.moves.resume({ name: 'dev-a' })),
  ]);

  expect(outcomes).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']);

  const imps = await ctx.client.imps.list();
  const tickets = await ctx.db.selectFrom('move_tickets').selectAll().execute();

  expect(imps.map((imp) => imp.name)).toEqual(['dev-a', 'prod']);
  expect(tickets).toEqual([]);

  // the same patterns without a list fork as before, grants and all
  await plain.client.imps.fork({ source: 'dev-a', name: 'dev-b' });

  const forked = await ctx.client.grants.list({ name: 'dev-b' });

  expect(forked).toEqual(['npm']);
});

test('a listed secret deleted, or deleted and made again, grants nothing, even after a restart', async () => {
  await using ctx = await setupTest();

  const agent = await ctx.createToken('agent', { grantable: ['gh'] });
  const browser = await ctx.createSession(agent.secret);

  await agent.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.secrets.delete({ name: 'gh' });

  const deleted = await readFailure(agent.client.grants.add({ name: 'dev-a', secret: 'gh' }));

  // made again under the name, by the host: another secret
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: VALUE });

  const remade = await Promise.all([
    readFailure(agent.client.grants.add({ name: 'dev-a', secret: 'gh' })),
    readFailure(browser.grants.add({ name: 'dev-a', secret: 'gh' })),
    readFailure(agent.client.grants.delete({ name: 'dev-a', secret: 'gh' })),
  ]);

  expect(deleted).toBe('FORBIDDEN not_grantable');

  expect(remade).toEqual([
    'FORBIDDEN not_grantable',
    'FORBIDDEN not_grantable',
    'FORBIDDEN not_grantable',
  ]);

  // the list still shows the name, and the token still may not fork
  const restarted = await ctx.startAgain();

  const after = buildClient(restarted.app, { authorization: `Bearer ${agent.secret}` });

  const outcomes = await Promise.all([
    readFailure(after.imps.fork({ source: 'dev-a', name: 'dev-b' })),
    readFailure(after.grants.add({ name: 'dev-a', secret: 'gh' })),
  ]);

  expect(outcomes).toEqual(['FORBIDDEN', 'FORBIDDEN not_grantable']);

  const identity = await after.tokens.whoami();

  expect(identity.grantable).toEqual(['gh']);
});

test('a grant a token made outlives sleep, wake, a checkpoint restore and a restart', async () => {
  await using ctx = await setupTest();

  const agent = await ctx.createToken('agent', { grantable: ['gh', 'npm'] });

  await agent.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await agent.client.grants.add({ name: 'dev-a', secret: 'npm' });

  const seen: string[][] = [];

  const readGrants = async (client: Client = agent.client) => {
    const names = await client.grants.list({ name: 'dev-a' });

    seen.push(names);
  };

  await agent.client.imps.sleep({ name: 'dev-a' });

  await readGrants();

  await agent.client.imps.wake({ name: 'dev-a' });

  await readGrants();

  const checkpoint = await agent.client.checkpoints.create({ name: 'dev-a' });

  await agent.client.grants.delete({ name: 'dev-a', secret: 'npm' });
  await agent.client.checkpoints.restore({ name: 'dev-a', checkpoint: checkpoint.id });

  await readGrants();

  const restarted = await ctx.startAgain();

  await readGrants(buildClient(restarted.app, { authorization: `Bearer ${agent.secret}` }));

  // a restore brings back the disk, not the grants of that time
  expect(seen).toEqual([['gh', 'npm'], ['gh', 'npm'], ['gh'], ['gh']]);
});

test('an imp made from a template gets no grants, and a destroyed imp takes its own', async () => {
  await using ctx = await setupTest();

  const agent = await ctx.createToken('agent', { grantable: ['gh'] });

  await agent.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.images.add({ imp: 'dev-a', name: 'dev-tpl' });
  await agent.client.imps.create({ name: 'dev-c', image: 'dev-tpl' });

  const fromTemplate = await agent.client.grants.list({ name: 'dev-c' });

  expect(fromTemplate).toEqual([]);

  await agent.client.imps.destroy({ name: 'dev-a' });
  await agent.client.imps.create({ name: 'dev-a' });

  const remade = await agent.client.grants.list({ name: 'dev-a' });

  expect(remade).toEqual([]);
});

test('no answer, error, log line or audit row holds a secret value', async () => {
  await using ctx = await setupTest();

  const printed: string[] = [];

  const spy = spyOn(console, 'error').mockImplementation((...args: readonly unknown[]) => {
    printed.push(
      args.map((arg) => (arg instanceof Error ? String(arg.stack) : String(arg))).join(' '),
    );
  });

  const answers: unknown[] = [];

  const collect = async (call: Promise<unknown>): Promise<void> => {
    try {
      const answer = await call;

      answers.push(answer);
    } catch (error) {
      answers.push(error, String(error));
    }
  };

  try {
    await ctx.client.secrets.add({
      name: 'gh-api',
      kind: 'custom',
      value: `${VALUE}-2`,
      rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    });

    const made = await ctx.client.tokens.create({
      name: 'agent',
      scope: 'manage',
      imps: ['dev-*'],
      grantable: ['gh', 'gh-api'],
    });

    answers.push(made.token);

    const agent = buildClient(ctx.app, { authorization: `Bearer ${made.secret}` });

    await collect(agent.grants.add({ name: 'dev-a', secret: 'gh' }));
    await collect(agent.grants.add({ name: 'dev-a', secret: 'gh-api' }));
    await collect(agent.grants.add({ name: 'dev-a', secret: 'npm' }));
    await collect(agent.grants.add({ name: 'prod', secret: 'gh' }));
    await collect(agent.imps.fork({ source: 'dev-a', name: 'dev-b' }));
    await collect(agent.grants.list({ name: 'dev-a' }));
    await collect(agent.secrets.list());
    await collect(agent.tokens.whoami());
    await collect(ctx.client.tokens.list());

    await collect(
      ctx.client.secrets.add({
        name: 'gh-api',
        kind: 'github',
        value: `${VALUE}-3`,
        replace: true,
      }),
    );

    await collect(agent.grants.delete({ name: 'dev-a', secret: 'gh' }));
  } finally {
    spy.mockRestore();
  }

  const calls = await listApiCalls(ctx.db, null, 100, null);
  const brokerRows = await ctx.db.selectFrom('broker_audit').selectAll().execute();

  // the refusals and the clash are there, by name
  expect(calls.map((call) => call.outcome)).toContain('FORBIDDEN');
  expect(calls.map((call) => call.outcome)).toContain('CONFLICT');

  const everything = JSON.stringify([answers, printed, ctx.logs, calls, brokerRows]);

  expect(everything).toContain('gh-api');
  expect(everything).not.toContain(VALUE);
});
