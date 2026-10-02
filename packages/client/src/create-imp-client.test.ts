import { expect, test } from 'bun:test';
import { TEST_TOKEN, buildTestApp, setupImpTest } from '@imp/daemon/src/imps/test-imps';
import { ORPCError } from '@orpc/client';
import { createImpClient } from './create-imp-client';
import { ImpErrorStateError } from './require-awake';

type App = ReturnType<typeof buildTestApp>['app'];

// a client over impd's app in-process, with fake VMs; `calls` lists every
// procedure it called, and `restartAfterUnavailable` brings up a new impd
// once the current one answers 503
async function setupClientTest(env: Readonly<Record<string, string>> = {}, token = TEST_TOKEN) {
  const harness = await setupImpTest({ env });

  const calls: string[] = [];

  const target: { app: App; next: App | null } = {
    app: buildTestApp(harness, harness).app,
    next: null,
  };

  const client = createImpClient({
    url: 'http://impd.test/',
    token,
    fetch: async (request) => {
      calls.push(new URL(request.url).pathname);

      const response = await target.app.handle(request);

      if (response.status === 503 && target.next !== null) {
        target.app = target.next;
        target.next = null;
      }

      return response;
    },
  });

  await harness.createTestImage('ubuntu');

  return {
    ...harness,
    client,
    calls,
    restartAfterUnavailable: () => {
      target.next = buildTestApp(harness, harness.restartImpd()).app;
    },
  };
}

test('it calls the contract with the bearer token', async () => {
  await using ctx = await setupClientTest();

  const created = await ctx.client.imps.create({ name: 'dev' });
  const listed = await ctx.client.imps.list();

  expect(created).toMatchObject({ name: 'dev', state: 'running' });
  expect(listed.map((imp) => imp.name)).toEqual(['dev']);
  expect(ctx.calls).toEqual(['/rpc/imps/create', '/rpc/imps/list']);
});

test('a wrong token is a 401', async () => {
  await using ctx = await setupClientTest({}, 'wrong');

  const rejection = await ctx.client.system.info().catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(ORPCError);
  expect(rejection).toMatchObject({ status: 401 });
});

test('requireAwake wakes a sleeping imp and boots a stopped one', async () => {
  await using ctx = await setupClientTest();

  await ctx.client.imps.create({ name: 'asleep' });
  await ctx.client.imps.sleep({ name: 'asleep' });
  await ctx.client.imps.create({ name: 'off' });
  await ctx.client.imps.stop({ name: 'off' });

  const woken = await ctx.client.requireAwake('asleep');
  const booted = await ctx.client.requireAwake('off');
  const again = await ctx.client.requireAwake('off');

  expect([woken.state, booted.state, again.state]).toEqual(['running', 'running', 'running']);
});

test('requireAwake refuses an imp in error unless told to restart it', async () => {
  await using ctx = await setupClientTest();

  ctx.fake.queue('boot', 'fail');

  await ctx.client.imps.create({ name: 'dev' }).catch(() => {});

  const rejection = await ctx.client.requireAwake('dev').catch((error: unknown) => error);
  const restarted = await ctx.client.requireAwake('dev', { restartError: true });

  expect(rejection).toBeInstanceOf(ImpErrorStateError);
  expect(restarted.state).toBe('running');
});

test('requireAwake passes RAM_BUDGET_EXCEEDED on after one try', async () => {
  await using ctx = await setupClientTest({
    IMP_RAM_BUDGET_MIB: '600',
    IMP_DEFAULT_MEMORY_MIB: '512',
    IMP_BOOT_RESERVE_PERCENT: '100',
  });

  await ctx.client.imps.create({ name: 'a' });
  await ctx.client.imps.stop({ name: 'a' });
  await ctx.client.imps.create({ name: 'b' });
  await ctx.client.imps.hold({ name: 'b', seconds: 600 });

  const rejection = await ctx.client
    .requireAwake('a', { retryUnavailable: { attempts: 3, delayMs: 1 } })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: { budgetMib: 600, requestedMib: 512 },
  });

  expect(ctx.calls.filter((path) => path === '/rpc/imps/wake')).toHaveLength(1);
});

test('requireAwake waits out a stopping impd when asked to', async () => {
  await using ctx = await setupClientTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.imps.sleepAllImps();

  const stopping = await ctx.client.requireAwake('dev').catch((error: unknown) => error);

  expect(stopping).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

  ctx.restartAfterUnavailable();

  ctx.calls.length = 0;

  const imp = await ctx.client.requireAwake('dev', {
    retryUnavailable: { attempts: 2, delayMs: 1 },
  });

  expect(imp.state).toBe('running');
  expect(ctx.calls).toEqual(['/rpc/imps/get', '/rpc/imps/wake', '/rpc/imps/wake']);
});

test('checkServer compares the versions', async () => {
  await using ctx = await setupClientTest();

  const check = await ctx.client.checkServer();

  expect(check).toEqual({ clientVersion: '0.0.0', serverVersion: '0.0.0', compatible: true });
});
