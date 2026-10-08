import { expect, test } from 'bun:test';
import { EVENT_VERSION } from '@imp/api';
import type { ImpContract, ImpEvent } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { buildSessionValue } from '../auth/session-cookie';
import { ROOT_TOKEN_ID } from '../auth/token-store';
import { listApiCalls } from '../db/api-audit';
import { findImpByName } from '../db/imps';
import { TEST_TOKEN, buildTestApp, setupImpTest } from '../imps/test-imps';
import type { ImpTest } from '../imps/test-imps';

async function setupEventTest(env: Readonly<Record<string, string>> = {}) {
  const harness = await setupImpTest({ env });

  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);

  return { ...harness, app, client: app.client };
}

// Every event a stream sends, as `ev reason` or `ev decision`, read in the
// background until `stop`.
async function readEvents(client: ContractRouterClient<ImpContract>) {
  const controller = new AbortController();

  const stream = await client.events.stream(undefined, { signal: controller.signal });

  const events: ImpEvent[] = [];

  const reading = (async () => {
    try {
      for await (const event of stream) {
        events.push(event);
      }
    } catch {
      // the abort below
    }
  })();

  return {
    events,
    lines: () => events.map((event) => formatEvent(event)),
    waitFor: async (line: string) => {
      const deadline = Date.now() + 5000;

      while (!events.some((event) => formatEvent(event) === line)) {
        if (Date.now() > deadline) {
          throw new Error(`no ${line} in ${events.map((event) => formatEvent(event)).join(', ')}`);
        }

        await Bun.sleep(1);
      }
    },
    stop: async () => {
      controller.abort();

      await reading;
    },
    ended: reading,
  };
}

function formatEvent(event: Readonly<ImpEvent>): string {
  if (event.ev === 'ImpAdded' || event.ev === 'ImpChanged') {
    return `${event.ev} ${event.reason} ${event.imp.name}`;
  }

  if (event.ev === 'GovernorDecision') {
    return `${event.ev} ${event.decision} ${event.name}`;
  }

  if (event.ev === 'ImpRemoved') {
    return `${event.ev} ${event.imp.name}`;
  }

  return `${event.ev} ${event.name}`;
}

interface DashboardApp {
  readonly app: { readonly handle: (request: Request) => Promise<Response> };
}

// a client that calls as the dashboard does: a session cookie, no token
function buildDashboardClient(app: DashboardApp, expiresAt: number) {
  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: {
      cookie: `imp_session=${buildSessionValue(TEST_TOKEN, { tokenId: ROOT_TOKEN_ID, expiresAt })}`,
      'sec-fetch-site': 'same-origin',
    },
    fetch: (request) => app.app.handle(request),
  });

  return createORPCClient<ContractRouterClient<ImpContract>>(link);
}

test('a stream sends the snapshot, then each change with its reason', async () => {
  const ctx = await setupEventTest();

  await ctx.client.imps.create({ name: 'old' });

  const stream = await readEvents(ctx.client);

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });
  await ctx.client.imps.destroy({ name: 'dev' });
  await stream.waitFor('ImpRemoved dev');
  await stream.stop();

  expect(stream.lines()).toEqual([
    'ImpAdded snapshot old',
    'ImpAdded created dev',
    'GovernorDecision admitted dev',
    'ImpChanged booted dev',
    'ImpChanged slept dev',
    'GovernorDecision admitted dev',
    'ImpChanged woke dev',
    'ImpRemoved dev',
  ]);

  const timed = stream.events.filter((event) => event.ev === 'ImpChanged');

  for (const event of timed.slice(0, 3)) {
    expect(event.detail?.durationMs).toBeNumber();
  }

  expect(timed[1]?.detail?.trigger).toBe('requested');
});

test('a slept event counts the work before its durationMs in prepareMs', async () => {
  const ctx = await setupEventTest({ IMP_SLEEP_MIN_GUEST_UPTIME_MS: '300' });

  await ctx.client.imps.create({ name: 'dev' });

  const stream = await readEvents(ctx.client);

  // a young guest: the sleep first waits about 200 ms before the pause
  ctx.fake.setGuestUptime(100);

  await ctx.client.imps.sleep({ name: 'dev' });
  await stream.waitFor('ImpChanged slept dev');
  await stream.stop();

  const slept = stream.events.find((event) => formatEvent(event) === 'ImpChanged slept dev');
  const detail = slept?.ev === 'ImpChanged' ? slept.detail : undefined;

  expect(detail?.prepareMs).toBeGreaterThanOrEqual(190);
  expect(detail?.durationMs).toBeLessThan(detail?.prepareMs ?? 0);
});

test('a liveness repair and a restarted impd adopting a VM each send an event', async () => {
  const ctx = await setupEventTest();

  await ctx.client.imps.create({ name: 'dead' });
  await ctx.client.imps.create({ name: 'alive' });

  const stream = await readEvents(ctx.client);
  const dead = await findImpByName(ctx.db, 'dead');

  ctx.fake.alive.delete(dead?.pid ?? 0);

  await ctx.client.imps.list();
  await stream.waitFor('ImpChanged repaired dead');
  await stream.stop();

  // a restart over the same VMs re-adopts the one still running
  const restarted = ctx.restartImpd();
  const adopted: string[] = [];

  restarted.imps.events.subscribe((event) => {
    adopted.push(formatEvent(event));
  });

  await restarted.imps.reconcileImps();

  await waitUntil(() => adopted.includes('ImpChanged adopted alive'));
});

test('a secret value reaches no event and no audit row', async () => {
  const ctx = await setupEventTest();

  await ctx.client.imps.create({ name: 'dev' });

  const stream = await readEvents(ctx.client);

  const value = 'ghp_secretvalue0123456789';

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.imps.sleep({ name: 'dev' });
  await stream.waitFor('ImpChanged slept dev');
  await stream.stop();

  const calls = await waitForCalls(ctx, 4);

  expect(JSON.stringify(stream.events)).not.toContain(value);
  expect(JSON.stringify(calls)).not.toContain(value);

  expect(calls.map((call) => [call.procedure, call.imp ?? null, call.actor])).toEqual([
    ['imps.sleep', 'dev', 'token'],
    ['grants.add', 'dev', 'token'],
    ['secrets.add', null, 'token'],
    ['imps.create', 'dev', 'token'],
  ]);
});

test('a dashboard stream ends at the session expiry and at any logout', async () => {
  const ctx = await setupEventTest();
  const expiring = await readEvents(buildDashboardClient(ctx.app, ctx.now() + 100));

  await expiring.ended;

  const dashboard = await readEvents(buildDashboardClient(ctx.app, ctx.now() + 60_000));
  const token = await readEvents(ctx.client);

  const logout = await ctx.app.app.handle(
    new Request('http://impd.test/auth/logout', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    }),
  );

  expect(logout.status).toBe(204);

  await dashboard.ended;

  await ctx.client.imps.create({ name: 'dev' });
  await token.waitFor('ImpAdded created dev');
  await token.stop();

  // the dashboard's mutations are its own in the audit log
  await buildDashboardClient(ctx.app, ctx.now() + 60_000).imps.stop({ name: 'dev' });

  const calls = await waitForCalls(ctx, 2);

  expect(calls.map((call) => call.actor)).toEqual(['dashboard', 'token']);
});

// a decision as the governor sends one; no imp is named with a space
function buildDecision(name: string): ImpEvent {
  return {
    v: EVENT_VERSION,
    at: new Date(),
    ev: 'GovernorDecision',
    decision: 'admitted',
    name,
    trigger: 'admission',
    usedMib: 0,
    budgetMib: 1024,
  };
}

// whether the stream is still open a moment on
async function isOpen(stream: Readonly<{ ended: Promise<void> }>): Promise<boolean> {
  const ended = await Promise.race([
    stream.ended.then(() => true),
    Bun.sleep(20).then(() => false),
  ]);

  return !ended;
}

test('an event that fails the schema is dropped and the stream goes on', async () => {
  const ctx = await setupEventTest();
  const stream = await readEvents(ctx.client);

  ctx.imps.events.publish(buildDecision('boot template'));
  ctx.imps.events.publish(buildDecision('good'));

  await stream.waitFor('GovernorDecision admitted good');

  const open = await isOpen(stream);

  expect(open).toBe(true);

  await stream.stop();

  expect(stream.lines()).toEqual(['GovernorDecision admitted good']);

  expect(ctx.logs.filter((line) => line.includes('fail the event schema'))).toEqual([
    'impd: dropped 1 GovernorDecision event(s) that fail the event schema; the latest at name: must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  ]);
});

test('a snapshot imp that fails the schema is dropped and the stream goes on', async () => {
  const ctx = await setupEventTest();

  await ctx.client.imps.create({ name: 'bad' });
  await ctx.client.imps.create({ name: 'good' });

  // a row no create would write
  await ctx.db.updateTable('imps').set({ name: 'Bad Name' }).where('name', '=', 'bad').execute();

  const stream = await readEvents(ctx.client);

  await stream.waitFor('ImpAdded snapshot good');

  ctx.imps.events.publish(buildDecision('later'));

  await stream.waitFor('GovernorDecision admitted later');

  const open = await isOpen(stream);

  expect(open).toBe(true);

  await stream.stop();

  expect(stream.lines()).toEqual(['ImpAdded snapshot good', 'GovernorDecision admitted later']);
});

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('the condition never held');
    }

    await Bun.sleep(1);
  }
}

// the audit log once it holds `count` rows; each lands after its answer
async function waitForCalls(ctx: Readonly<Pick<ImpTest, 'db'>>, count: number) {
  const deadline = Date.now() + 5000;

  for (;;) {
    const calls = await listApiCalls(ctx.db, null, 100, null);

    if (calls.length >= count || Date.now() > deadline) {
      return calls;
    }

    await Bun.sleep(1);
  }
}
