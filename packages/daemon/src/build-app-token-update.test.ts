import { expect, test } from 'bun:test';
import type { ImpContract, Scope } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadTokenStore } from './auth/token-store';
import type { Broker } from './broker/broker-service';
import { findImpByName } from './db/imps';
import { findSecret } from './db/secrets';
import { listTokenRecords } from './db/tokens';
import { TEST_TOKEN, buildTestApp, setupImpTest } from './imps/test-imps';

// tokens.update: a token's grantable list changed in place
// (docs/guides/tokens.md#change-the-list), through the API as a client calls it.

const ORIGIN = 'http://impd.test';
const VALUE = 'sk-synthetic-119-0123456789abcdef';

interface RequestHandler {
  readonly handle: (request: Request) => Promise<Response>;
}

interface TokenOptions {
  readonly scope?: Scope;

  // null: host-wide
  readonly imps?: readonly string[] | null;
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

  for (const name of ['dev-a', 'dev-b', 'prod']) {
    await root.client.imps.create({ name });
  }

  await root.client.secrets.add({ name: 'gh', kind: 'github', value: VALUE });
  await root.client.secrets.add({ name: 'npm', kind: 'npm', value: VALUE });

  // a manage token for dev-* unless the options say otherwise
  const createToken = async (name: string, options: TokenOptions = {}) => {
    const made = await root.client.tokens.create({
      name,
      scope: options.scope ?? 'manage',
      ...(options.imps !== null && { imps: [...(options.imps ?? ['dev-*'])] }),
      ...(options.grantable !== undefined && { grantable: [...options.grantable] }),
    });

    return {
      secret: made.secret,
      client: buildClient(root.app, { authorization: `Bearer ${made.secret}` }),
    };
  };

  const isGranted = async (impName: string, host: string): Promise<boolean> => {
    const imp = await findImpByName(harness.db, impName);

    return harness.broker.isGranted(imp?.id ?? '', host);
  };

  // the generation each entry of the token's list holds, by name
  const readGenerations = async (name: string): Promise<Record<string, string>> => {
    const records = await listTokenRecords(harness.db);

    const record = records.find((each) => each.name === name);

    return Object.fromEntries(
      (record?.grantable ?? []).map((secret) => [secret.name, secret.generation]),
    );
  };

  // an app whose grants run `between` after the access check and before
  // their transaction
  const buildAppWithGap = (between: () => Promise<void>) => {
    const broker: Broker = {
      ...harness.broker,
      addGrant: async (...args) => {
        await between();

        return harness.broker.addGrant(...args);
      },
    };

    return buildTestApp({ ...harness, broker }, harness);
  };

  // impd restarted on the same database
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

  return {
    ...harness,
    ...root,
    createToken,
    isGranted,
    readGenerations,
    buildAppWithGap,
    startAgain,
  };
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

test('only a host-wide manage caller may change a grantable list, as with a grant', async () => {
  const ctx = await setupTest();

  await ctx.createToken('agent', { grantable: ['gh'] });

  const callers = {
    'host-wide manage': await ctx.createToken('admin', { imps: null }),
    'host-wide exec': await ctx.createToken('runner', { scope: 'exec', imps: null }),
    'dev-* manage': await ctx.createToken('dev', {}),
    'dev-* manage that may grant': await ctx.createToken('granter', { grantable: ['gh', 'npm'] }),
  };

  const outcomes: string[] = [];

  for (const [label, caller] of Object.entries(callers)) {
    const update = await readFailure(
      caller.client.tokens.update({ name: 'agent', grantable: ['gh', 'npm'] }),
    );

    // the same rule as a grant on an imp outside every pattern
    const grant = await readFailure(caller.client.grants.add({ name: 'prod', secret: 'npm' }));

    outcomes.push(`${label}: update ${update}, grant ${grant}`);

    // the next caller's grant starts from none
    await readFailure(ctx.client.grants.delete({ name: 'prod', secret: 'npm' }));
  }

  // a refused update leaves the list as it was
  await readFailure(callers['dev-* manage'].client.tokens.update({ name: 'agent', grantable: [] }));

  const tokens = await ctx.client.tokens.list();

  const agent = tokens.find((token) => token.name === 'agent');

  expect(outcomes).toEqual([
    'host-wide manage: update ok, grant ok',
    'host-wide exec: update FORBIDDEN scope, grant FORBIDDEN scope',
    'dev-* manage: update FORBIDDEN, grant FORBIDDEN imp_out_of_scope',
    'dev-* manage that may grant: update FORBIDDEN, grant FORBIDDEN imp_out_of_scope',
  ]);

  expect(agent?.grantable).toEqual(['gh', 'npm']);
});

test('a secret taken off the list loses its grants on the token’s imps, and only there', async () => {
  const ctx = await setupTest();
  const agent = await ctx.createToken('agent', { grantable: ['gh', 'npm'] });

  // made through the token, by the root token on one of its imps, and on an
  // imp outside its patterns
  await agent.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await agent.client.grants.add({ name: 'dev-a', secret: 'npm' });
  await ctx.client.grants.add({ name: 'dev-b', secret: 'gh' });
  await ctx.client.grants.add({ name: 'prod', secret: 'gh' });

  const before = await ctx.isGranted('dev-a', 'api.github.com');
  const updated = await ctx.client.tokens.update({ name: 'agent', grantable: ['npm'] });

  const grants = {
    'dev-a': await ctx.client.grants.list({ name: 'dev-a' }),
    'dev-b': await ctx.client.grants.list({ name: 'dev-b' }),
    prod: await ctx.client.grants.list({ name: 'prod' }),
  };

  const brokered = await Promise.all([
    ctx.isGranted('dev-a', 'api.github.com'),
    ctx.isGranted('dev-a', 'registry.npmjs.org'),
    ctx.isGranted('prod', 'api.github.com'),
  ]);

  // and the token may not grant it again
  const regrant = await readFailure(agent.client.grants.add({ name: 'dev-a', secret: 'gh' }));

  expect(before).toBeTrue();
  expect(updated.grantable).toEqual(['npm']);
  expect(grants).toEqual({ 'dev-a': ['npm'], 'dev-b': [], prod: ['gh'] });
  expect(brokered).toEqual([false, true, true]);
  expect(regrant).toBe('FORBIDDEN not_grantable');
});

test('each entry takes its secret’s generation now, as a fresh token does', async () => {
  const ctx = await setupTest();
  const agent = await ctx.createToken('agent', { grantable: ['gh'] });

  // a rebind gives gh another generation, so the list no longer covers it
  await ctx.client.secrets.add({
    name: 'gh',
    kind: 'custom',
    value: VALUE,
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    replace: true,
    rebind: true,
  });

  const stale = await readFailure(agent.client.grants.add({ name: 'dev-a', secret: 'gh' }));

  await ctx.client.tokens.update({ name: 'agent', grantable: ['gh', 'npm'] });

  const updated = await ctx.readGenerations('agent');

  // a fresh token made now holds the same generations
  await ctx.createToken('fresh', { grantable: ['gh', 'npm'] });

  const fresh = await ctx.readGenerations('fresh');
  const current = await Promise.all(['gh', 'npm'].map((name) => findSecret(ctx.db, name)));

  const granted = await Promise.all([
    readFailure(agent.client.grants.add({ name: 'dev-a', secret: 'gh' })),
    readFailure(agent.client.grants.add({ name: 'dev-b', secret: 'npm' })),
  ]);

  expect(stale).toBe('FORBIDDEN not_grantable');
  expect(updated).toEqual({ gh: current[0]?.generation ?? '', npm: current[1]?.generation ?? '' });
  expect(fresh).toEqual(updated);
  expect(granted).toEqual(['ok', 'ok']);
});

test('the change is in the API audit log, refused or made', async () => {
  const ctx = await setupTest();
  const dev = await ctx.createToken('dev', {});

  await ctx.createToken('agent', { grantable: ['gh'] });
  await ctx.client.tokens.update({ name: 'agent', grantable: ['npm'] });

  await readFailure(dev.client.tokens.update({ name: 'agent', grantable: [] }));

  // what `imp audit --kind api` reads
  const calls = await ctx.client.audit.calls({});

  const updates = calls
    .filter((call) => call.procedure === 'tokens.update')
    .map((call) => `${call.actor} ${call.actorName ?? ''} ${call.outcome}`);

  expect(updates.toSorted()).toEqual(['token dev FORBIDDEN', 'token root ok']);
  expect(JSON.stringify(calls)).not.toContain(VALUE);
});

test('the token keeps its secret: its bearer, its id and its hash stay, through a restart', async () => {
  const ctx = await setupTest();
  const agent = await ctx.createToken('agent', { grantable: ['gh'] });
  const [before] = await listTokenRecords(ctx.db);
  const updated = await ctx.client.tokens.update({ name: 'agent', grantable: ['gh', 'npm'] });
  const [after] = await listTokenRecords(ctx.db);

  // the client made with the old secret works on, and sees the new list
  const whoami = await agent.client.tokens.whoami();

  // the update answers with the token, never a secret
  const answer = JSON.stringify(updated);

  const restarted = await ctx.startAgain();

  const again = buildClient(restarted.app, { authorization: `Bearer ${agent.secret}` });

  const afterRestart = await again.tokens.whoami();

  expect(after?.id).toBe(before?.id ?? '');
  expect(after?.secretHash).toBe(before?.secretHash ?? '');
  expect(after?.createdAt).toEqual(before?.createdAt ?? new Date(0));
  expect(whoami).toMatchObject({ name: 'agent', grantable: ['gh', 'npm'] });
  expect(afterRestart).toMatchObject({ name: 'agent', grantable: ['gh', 'npm'] });
  expect(answer).not.toContain(agent.secret);
});

test('a grant checked before the update and run after it is refused in the transaction', async () => {
  const ctx = await setupTest();
  const agent = await ctx.createToken('agent', { grantable: ['gh', 'npm'] });

  const gapped = ctx.buildAppWithGap(async () => {
    await ctx.client.tokens.update({ name: 'agent', grantable: ['npm'] });
  });

  const client = buildClient(gapped.app, { authorization: `Bearer ${agent.secret}` });

  const outcome = await readFailure(client.grants.add({ name: 'dev-a', secret: 'gh' }));
  const grants = await ctx.client.grants.list({ name: 'dev-a' });

  expect(outcome).toBe('FORBIDDEN not_grantable');
  expect(grants).toEqual([]);
});

test('an update refuses what tokens.create refuses, and an empty list clears it', async () => {
  const ctx = await setupTest();

  await ctx.createToken('agent', { grantable: ['gh'] });
  await ctx.createToken('admin', { imps: null });
  await ctx.createToken('runner', { scope: 'exec' });

  const outcomes = await Promise.all([
    readFailure(ctx.client.tokens.update({ name: 'admin', grantable: ['gh'] })),
    readFailure(ctx.client.tokens.update({ name: 'runner', grantable: ['gh'] })),
    readFailure(ctx.client.tokens.update({ name: 'agent', grantable: ['nope'] })),
    readFailure(ctx.client.tokens.update({ name: 'nobody', grantable: [] })),
    readFailure(ctx.client.tokens.update({ name: 'agent', grantable: ['gh', 'gh'] })),
    readFailure(ctx.client.tokens.update({ name: 'root', grantable: [] })),
  ]);

  const cleared = await ctx.client.tokens.update({ name: 'agent', grantable: [] });

  expect(outcomes).toEqual([
    'BAD_REQUEST',
    'BAD_REQUEST',
    'NOT_FOUND',
    'NOT_FOUND',
    'BAD_REQUEST',
    'NOT_FOUND',
  ]);

  const generations = await ctx.readGenerations('agent');

  expect(cleared.grantable).toEqual([]);
  expect(generations).toEqual({});
});
