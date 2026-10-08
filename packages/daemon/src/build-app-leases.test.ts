import { expect, test } from 'bun:test';
import type { ImpContract, ImpEvent, Scope } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { listLeases, writeLease } from './db/leases';
import { readPresentedLeases } from './imps/imp-presenter';
import { TEST_TOKEN, buildTestApp, setupImpTest } from './imps/test-imps';
import { readRejection } from './read-rejection';

type Client = ContractRouterClient<ImpContract>;

async function setupTest(env: Readonly<Record<string, string>> = {}) {
  // a frozen clock: lease ends compare exactly
  const harness = await setupImpTest({ env, frozenClockMs: Date.now() });

  const root = buildTestApp(harness, harness, TEST_TOKEN);

  // a client for a new token, and the principal impd takes it for
  const createTokenClient = async (
    name: string,
    scope: Scope = 'exec',
    imps: readonly string[] | null = null,
  ) => {
    const made = await root.client.tokens.create({
      name,
      scope,
      ...(imps !== null && { imps: [...imps] }),
    });

    const link = new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: (request) => root.app.handle(request),
    });

    const client: Client = createORPCClient(link);
    const principal = harness.tokens.authenticate(made.secret)?.principal ?? '';

    return { client, principal };
  };

  const events: ImpEvent[] = [];

  harness.imps.events.subscribe((event) => {
    events.push(event);
  });

  await harness.createTestImage('ubuntu');

  return { ...harness, ...root, createTokenClient, events };
}

test('two owners lease one imp, and each sees and releases only its own', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const a = await ctx.createTokenClient('a');
  const b = await ctx.createTokenClient('b');
  const leased = await a.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  await b.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 120 });

  expect(leased).toEqual({
    name: 'dev',
    owner: { principal: a.principal, display: 'a', label: 'job' },
    until: new Date(ctx.now() + 60_000),
  });

  const seenByA = await a.client.leases.list({});
  const seenByRoot = await ctx.client.leases.list({ name: 'dev' });
  const impForA = await a.client.imps.get({ name: 'dev' });
  const impForRoot = await ctx.client.imps.get({ name: 'dev' });

  expect(seenByA.map((lease) => lease.owner.display)).toEqual(['a']);
  expect(seenByRoot.map((lease) => lease.owner.display).toSorted()).toEqual(['a', 'b']);
  expect(impForA.leases?.leases.map((lease) => lease.owner.display)).toEqual(['a']);
  expect(impForA.leases?.otherCount).toBe(1);
  expect(impForRoot.leases?.otherCount).toBe(0);
  expect(impForRoot.holdUntil).toEqual(new Date(ctx.now() + 120_000));

  const released = await a.client.leases.release({ name: 'dev', label: 'job' });
  const again = await a.client.leases.release({ name: 'dev', label: 'job' });
  const left = await ctx.client.leases.list({});

  expect(released).toEqual({ released: true });
  expect(again).toEqual({ released: false });
  expect(left.map((lease) => lease.owner.display)).toEqual(['b']);
});

test('a renew moves the end of a live lease only, and wakes nothing', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 30 });

  ctx.advance(20_000);

  const renewed = await ctx.client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 30 });

  expect(renewed.until).toEqual(new Date(ctx.now() + 30_000));

  // a shorter ttl never shortens it
  const kept = await ctx.client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 10 });

  expect(kept.until).toEqual(renewed.until);

  ctx.advance(30_000);

  await ctx.client.imps.sleep({ name: 'dev' });

  const ended = await readRejection(
    ctx.client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 30 }),
  );

  const imp = await ctx.client.imps.get({ name: 'dev' });
  const leases = await ctx.client.leases.list({});

  expect(ended).toMatchObject({ code: 'LEASE_NOT_HELD' });
  expect(imp.state).toBe('sleeping');
  expect(imp.holdUntil).toBeUndefined();
  expect(leases).toEqual([]);
});

test('an acquire wakes the imp, and emits held with counts but no owners', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  await Bun.sleep(10);

  const held = ctx.events.find((event) => event.ev === 'ImpChanged' && event.reason === 'held');

  expect(imp.state).toBe('running');
  expect(held).toMatchObject({ imp: { leases: { leases: [], otherCount: 1 } } });
});

test('a lease may not take the label hold, which never blocks a sleep', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const refused = await readRejection(
    ctx.client.leases.acquire({ name: 'dev', label: 'hold', ttlSeconds: 60 }),
  );

  expect(refused).toMatchObject({ code: 'BAD_REQUEST' });
});

test('a sleep or stop of a leased imp fails with LEASED, as each caller may see it', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const a = await ctx.createTokenClient('a');
  const b = await ctx.createTokenClient('b');

  await a.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  const forB = await readRejection(b.client.imps.sleep({ name: 'dev' }));
  const forA = await readRejection(a.client.imps.stop({ name: 'dev' }));
  const forRoot = await readRejection(ctx.client.imps.sleep({ name: 'dev' }));

  expect(forB).toMatchObject({ code: 'LEASED', data: { leases: [], otherCount: 1 } });

  expect(forA).toMatchObject({
    code: 'LEASED',
    data: { leases: [{ owner: { principal: a.principal, label: 'job' } }], otherCount: 0 },
  });

  expect(forRoot).toMatchObject({ code: 'LEASED', data: { otherCount: 0 } });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.state).toBe('running');
});

test('a forced sleep ends the leases, keeps the holds, and a renew finds none', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const a = await ctx.createTokenClient('a');

  await a.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await a.client.leases.acquire({ name: 'dev', label: 'other', ttlSeconds: 60 });
  await ctx.client.imps.hold({ name: 'dev', seconds: 600 });

  const asleep = await ctx.client.imps.sleep({ name: 'dev', force: true });

  await Bun.sleep(10);

  const released = ctx.events.find(
    (event) => event.ev === 'ImpChanged' && event.reason === 'released',
  );

  const renew = await readRejection(
    a.client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 60 }),
  );

  const leases = await ctx.client.leases.list({ name: 'dev' });

  expect(asleep.state).toBe('sleeping');
  expect(released).toMatchObject({ detail: { released: 2 } });
  expect(renew).toMatchObject({ code: 'LEASE_NOT_HELD' });
  expect(leases.map((lease) => lease.owner.label)).toEqual(['hold']);
  expect(asleep.holdUntil).toEqual(new Date(ctx.now() + 600_000));
});

test('an old-shape sleep of a held imp still sleeps it, and the hold survives', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.hold({ name: 'dev', seconds: 600 });

  const asleep = await ctx.client.imps.sleep({ name: 'dev' });
  const stopped = await ctx.client.imps.stop({ name: 'dev' });

  expect(asleep.state).toBe('sleeping');
  expect(stopped.state).toBe('stopped');
  expect(stopped.holdUntil).toEqual(new Date(ctx.now() + 600_000));
});

test('hold 0 releases the caller’s hold and a legacy one, and keeps the others', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });
  const a = await ctx.createTokenClient('a');
  const b = await ctx.createTokenClient('b');

  await a.client.imps.hold({ name: 'dev', seconds: 600 });
  await b.client.imps.hold({ name: 'dev', seconds: 900 });
  await b.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  const at = ctx.now();

  await writeLease(
    ctx.db,
    {
      impId: created.id,
      principal: 'legacy',
      label: 'hold',
      display: 'legacy',
      until: new Date(at + 300_000),
      createdAt: new Date(at),
    },
    { at, reason: null },
  );

  await a.client.imps.hold({ name: 'dev', seconds: 0 });

  const left = await listLeases(ctx.db, ctx.now());

  expect(left.map((lease) => `${lease.principal}/${lease.label}`)).toEqual([
    `${b.principal}/hold`,
    `${b.principal}/job`,
  ]);
});

test('a new token with a deleted token’s name holds none of its leases', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const first = await ctx.createTokenClient('ci');

  await first.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await ctx.client.tokens.delete({ name: 'ci' });

  const second = await ctx.createTokenClient('ci');
  const seen = await second.client.leases.list({});

  const renew = await readRejection(
    second.client.leases.renew({ name: 'dev', label: 'job', ttlSeconds: 60 }),
  );

  expect(second.principal).not.toBe(first.principal);
  expect(seen).toEqual([]);
  expect(renew).toMatchObject({ code: 'LEASE_NOT_HELD' });
});

test('a list leaves out the imps a limited caller may not reach', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });

  const limited = await ctx.createTokenClient('limited', 'exec', ['dev-*']);

  await ctx.client.leases.acquire({ name: 'prod', label: 'job', ttlSeconds: 60 });
  await limited.client.leases.acquire({ name: 'dev-a', label: 'job', ttlSeconds: 60 });

  const all = await limited.client.leases.list({});
  const named = await readRejection(limited.client.leases.list({ name: 'prod' }));

  expect(all.map((lease) => lease.name)).toEqual(['dev-a']);
  expect(named).toMatchObject({ code: 'FORBIDDEN' });
});

test('the shutdown pass sleeps a leased imp and keeps its lease', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });
  await ctx.imps.sleepAllImps();

  const leases = await listLeases(ctx.db, ctx.now());

  expect(ctx.fake.alive.size).toBe(0);
  expect(leases.map((lease) => lease.label)).toEqual(['job']);
});

test('a refusal names only the protected imps the caller may read', async () => {
  // 300 MiB per awake imp, 50% of 512 MiB reserved per boot
  const ctx = await setupTest({ IMP_RAM_BUDGET_MIB: '800', IMP_DEFAULT_MEMORY_MIB: '512' });

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.sleep({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'dev-b' });
  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.leases.acquire({ name: 'dev-b', label: 'job', ttlSeconds: 600 });
  await ctx.client.leases.acquire({ name: 'prod', label: 'job', ttlSeconds: 600 });

  const limited = await ctx.createTokenClient('limited', 'exec', ['dev-*']);

  const refused = await readRejection(
    limited.client.leases.acquire({ name: 'dev-a', label: 'job', ttlSeconds: 60 }),
  );

  const leases = await ctx.client.leases.list({ name: 'dev-a' });

  expect(refused).toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: {
      budgetMib: 800,
      neededMib: 100,
      protected: [{ name: 'dev-b', ramMib: 300, leased: true, busy: false }],
      protectedHidden: 1,
    },
  });

  // a refused acquire keeps no lease
  expect(leases).toEqual([]);

  await Bun.sleep(10);

  const decision = ctx.events.find(
    (event) => event.ev === 'GovernorDecision' && event.decision === 'refused',
  );

  expect(decision).toMatchObject({ neededMib: 100, protectedCount: 2 });
});

test('every write sets holdUntil from the live leases, longer or shorter', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const a = await ctx.createTokenClient('a');

  const at = ctx.now();

  const readHold = async () => {
    const imp = await ctx.client.imps.get({ name: 'dev' });

    return imp.holdUntil?.getTime() ?? null;
  };

  await a.client.leases.acquire({ name: 'dev', label: 'short', ttlSeconds: 60 });
  await a.client.leases.acquire({ name: 'dev', label: 'long', ttlSeconds: 600 });

  const acquired = await readHold();

  await a.client.leases.renew({ name: 'dev', label: 'short', ttlSeconds: 900 });

  const renewed = await readHold();

  await a.client.leases.release({ name: 'dev', label: 'short' });

  const released = await readHold();

  await a.client.imps.hold({ name: 'dev', seconds: 30 });
  await a.client.imps.hold({ name: 'dev', seconds: 0 });

  const unheld = await readHold();

  await ctx.client.imps.hold({ name: 'dev', seconds: 30 });
  await ctx.client.imps.sleep({ name: 'dev', force: true });

  const cleared = await readHold();

  expect([acquired, renewed, released, unheld, cleared]).toEqual([
    at + 600_000,
    at + 900_000,
    at + 600_000,
    at + 600_000,

    // the forced sleep took the leases; root's hold stays
    at + 30_000,
  ]);
});

test('a forced sleep that fails keeps the leases and emits no release', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  ctx.fake.queue('sleep', 'fail');

  const failed = await readRejection(ctx.client.imps.sleep({ name: 'dev', force: true }));

  await Bun.sleep(10);

  const leases = await ctx.client.leases.list({ name: 'dev' });
  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(failed).not.toBeNull();
  expect(leases.map((lease) => lease.owner.label)).toEqual(['job']);
  expect(imp.holdUntil).toEqual(new Date(ctx.now() + 60_000));

  expect(ctx.events.some((event) => event.ev === 'ImpChanged' && event.reason === 'released')).toBe(
    false,
  );
});

test('a sleep of a sleeping leased imp, or a stop of a stopped one, answers as before', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 600 });

  // as after an impd restart: the shutdown pass slept it and kept the lease
  await ctx.imps.sleepAllImps();

  const asleep = await ctx.client.imps.sleep({ name: 'dev' });

  await ctx.client.imps.stop({ name: 'dev', force: true });

  const at = ctx.now();

  await writeLease(
    ctx.db,
    {
      impId: created.id,
      principal: 'token:other',
      label: 'job',
      display: 'other',
      until: new Date(at + 600_000),
      createdAt: new Date(at),
    },
    { at, reason: null },
  );

  const stopped = await ctx.client.imps.stop({ name: 'dev' });
  const leases = await listLeases(ctx.db, ctx.now());

  expect(asleep.state).toBe('sleeping');
  expect(stopped.state).toBe('stopped');
  expect(leases.map((lease) => lease.principal)).toEqual(['token:other']);
});

test('hold 0 emits held even when it releases nothing', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await Bun.sleep(10);

  const before = ctx.events.length;

  await ctx.client.imps.hold({ name: 'dev', seconds: 0 });
  await Bun.sleep(10);

  const after = ctx.events.slice(before);

  expect(after).toMatchObject([{ ev: 'ImpChanged', reason: 'held' }]);
});

test('an imp answer names its lease owners from the presenter’s one read', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.leases.acquire({ name: 'dev', label: 'job', ttlSeconds: 60 });

  const presented = await ctx.imps.getImp('dev');

  expect(readPresentedLeases(presented)?.map((lease) => lease.label)).toEqual(['job']);
});
