import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import type { ImpContract } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { buildApp } from './build-app';
import { createCheckpointService } from './checkpoints/checkpoint-service';
import { setupImpTest } from './imps/test-imps';

const TOKEN = 'test-token';

async function setupTest(token: string, env: Readonly<Record<string, string>> = {}) {
  const harness = await setupImpTest({ env });

  const built = buildApp({
    config: harness.config,
    db: harness.db,
    token: TOKEN,
    imps: harness.imps,
    images: harness.images,
    governor: harness.governor,
    checkpoints: createCheckpointService({
      config: harness.config,
      db: harness.db,
      imps: harness.imps,
    }),
    firecrackerVersion: 'v1.17.0',
    readTailscale: () => Promise.resolve({ state: null, hostname: null, ip: null }),
    isReady: () => true,
  });

  const app = built.app;

  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: { authorization: `Bearer ${token}` },
    fetch: (request) => app.handle(request),
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(link);

  return {
    app,
    closeExecSessions: built.closeExecSessions,
    imps: harness.imps,
    client,
    db: harness.db,
    dataDir: harness.dataDir,
    fake: harness.fake,
    taps: harness.taps,
    createTestImage: harness.createTestImage,
    [Symbol.asyncDispose]: () => harness[Symbol.asyncDispose](),
  };
}

test('it serves system.info from config and the database', async () => {
  await using ctx = await setupTest(TOKEN);

  const info = await ctx.client.system.info();

  expect(info).toEqual({
    version: '0.0.0',
    ramBudgetMib: 16_384,
    ramUsedMib: 0,
    ramReservedMib: 0,
    ramCommittedMib: 0,
    awakeCount: 0,
    impCount: 0,
    firecrackerVersion: 'v1.17.0',
    tailscale: { enabled: false, state: null, hostname: null, ip: null },
  });
});

test('it rejects a request with the wrong token', async () => {
  await using ctx = await setupTest('wrong');

  const rejection = await ctx.client.system.info().catch((error: unknown) => error);

  expect(rejection).toMatchObject({ status: 401 });
});

test('it answers /health without a token', async () => {
  await using ctx = await setupTest(TOKEN);

  const response = await ctx.app.handle(new Request('http://impd.test/health'));
  const body: unknown = await response.json();

  expect(body).toEqual({ status: 'ok', ready: true });
});

test('it creates, stops, starts and destroys an imp', async () => {
  await using ctx = await setupTest(TOKEN);

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  expect(created).toMatchObject({
    name: 'dev',
    image: 'ubuntu',
    state: 'running',
    slot: 0,
    ip: '10.66.0.2',
    port: 20_000,
    url: 'http://dev.imp.localhost:7080',
  });

  expect(ctx.taps).toEqual(['imp0']);

  const stopped = await ctx.client.imps.stop({ name: 'dev' });

  expect(stopped.state).toBe('stopped');
  expect(ctx.fake.stops).toEqual([{ pid: 1001, graceful: true }]);

  const started = await ctx.client.imps.start({ name: 'dev' });
  const info = await ctx.client.system.info();

  expect(started.state).toBe('running');

  expect(info).toMatchObject({
    impCount: 1,
    awakeCount: 1,
    ramUsedMib: 300,
    ramCommittedMib: 2048,
  });

  await ctx.client.imps.destroy({ name: 'dev' });

  const imps = await ctx.client.imps.list();

  expect(imps).toEqual([]);
  expect(ctx.fake.alive.size).toBe(0);
});

test('it prefers the configured default image and falls back to ubuntu', async () => {
  await using ctx = await setupTest(TOKEN);

  await ctx.createTestImage('ubuntu');

  const first = await ctx.client.imps.create({ name: 'a' });

  await ctx.createTestImage('base');

  const second = await ctx.client.imps.create({});

  expect(first.image).toBe('ubuntu');
  expect(second.image).toBe('base');
  expect(second.name).toMatch(/^imp-[a-z0-9]{4}$/);
});

test('it rejects a duplicate name and an unknown image', async () => {
  await using ctx = await setupTest(TOKEN);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const duplicate = await ctx.client.imps.create({ name: 'dev' }).catch((error: unknown) => error);

  const unknown = await ctx.client.imps
    .create({ name: 'other', image: 'nope' })
    .catch((error: unknown) => error);

  expect(duplicate).toMatchObject({ code: 'CONFLICT', data: { kind: 'imp', name: 'dev' } });
  expect(unknown).toMatchObject({ code: 'NOT_FOUND', data: { kind: 'image', name: 'nope' } });
});

test('it marks a running imp stopped when its VM died', async () => {
  await using ctx = await setupTest(TOKEN);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  ctx.fake.alive.clear();

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.state).toBe('stopped');
});

test('it refuses to remove an image an imp uses', async () => {
  await using ctx = await setupTest(TOKEN);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const rejection = await ctx.client.images
    .delete({ name: 'ubuntu' })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'CONFLICT' });
});

test('it sleeps, wakes and holds an imp', async () => {
  await using ctx = await setupTest(TOKEN);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const asleep = await ctx.client.imps.sleep({ name: 'dev' });

  expect(asleep.state).toBe('sleeping');
  expect(asleep.sleptAt).toBeInstanceOf(Date);
  expect(ctx.fake.alive.size).toBe(0);

  const awake = await ctx.client.imps.wake({ name: 'dev' });

  expect(awake).toMatchObject({ state: 'running', ramMib: 300 });
  expect(ctx.fake.wakes).toEqual([1002]);

  await ctx.client.imps.sleep({ name: 'dev' });

  const held = await ctx.client.imps.hold({ name: 'dev', seconds: 60 });

  expect(held.state).toBe('running');
  expect(held.holdUntil?.getTime()).toBeGreaterThan(Date.now() + 50_000);

  const released = await ctx.client.imps.hold({ name: 'dev', seconds: 0 });

  expect(released.holdUntil).toBeUndefined();
});

test('it boots cold when the snapshot belongs to another firecracker', async () => {
  await using ctx = await setupTest(TOKEN);

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  const metaPath = `${ctx.dataDir}/imps/${created.id}/snapshot/meta.json`;

  const meta = await Bun.file(metaPath).text();

  await Bun.write(metaPath, meta.replace('"v1.17.0"', '"v0.1.0"'));

  const awake = await ctx.client.imps.wake({ name: 'dev' });

  expect(awake.state).toBe('running');
  expect(ctx.fake.wakes).toEqual([]);
});

test('it sleeps the least recently active imp to fit a new one in the budget', async () => {
  // 300 MiB per awake imp, 50% of 512 MiB reserved per boot
  await using ctx = await setupTest(TOKEN, {
    IMP_RAM_BUDGET_MIB: '800',
    IMP_DEFAULT_MEMORY_MIB: '512',
  });

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'a' });
  await Bun.sleep(5);
  await ctx.client.imps.create({ name: 'b' });
  await Bun.sleep(5);
  await ctx.client.imps.create({ name: 'c' });

  const states = await ctx.client.imps.list();

  expect(states.map((imp) => [imp.name, imp.state])).toEqual([
    ['a', 'sleeping'],
    ['b', 'running'],
    ['c', 'running'],
  ]);

  await ctx.client.imps.hold({ name: 'b', seconds: 600 });
  await ctx.client.imps.hold({ name: 'c', seconds: 600 });

  const rejection = await ctx.client.imps.wake({ name: 'a' }).catch((error: unknown) => error);

  expect(rejection).toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: { budgetMib: 800, requestedMib: 300 },
  });
});

test('it leaves nothing behind when an imp is larger than the RAM budget', async () => {
  await using ctx = await setupTest(TOKEN, { IMP_RAM_BUDGET_MIB: '800' });

  await ctx.createTestImage('ubuntu');

  const rejection = await ctx.client.imps
    .create({ name: 'huge', memoryMib: 900 })
    .catch((error: unknown) => error);

  const imps = await ctx.client.imps.list();

  expect(rejection).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED', data: { requestedMib: 900 } });
  expect(imps).toEqual([]);
  expect(readdirSync(`${ctx.dataDir}/imps`)).toEqual([]);

  // the name and the slot are free again
  const created = await ctx.client.imps.create({ name: 'huge', memoryMib: 512 });

  expect(created).toMatchObject({ state: 'running', slot: 0 });
});

test('it records a boot failure as the error state with its first line', async () => {
  await using ctx = await setupTest(TOKEN);

  await ctx.createTestImage('ubuntu');

  ctx.fake.control.failBoot = true;

  const rejection = await ctx.client.imps.create({ name: 'dev' }).catch((error: unknown) => error);
  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(rejection).toBeInstanceOf(Error);
  expect(imp).toMatchObject({ state: 'error', error: 'boot failed: no agent' });

  const started = await ctx.client.imps.start({ name: 'dev' });

  expect(started.state).toBe('running');
});

test('it re-adopts live VMs on reconcile, even with a silent agent', async () => {
  await using ctx = await setupTest(TOKEN);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'alive' });
  await ctx.client.imps.create({ name: 'dead' });
  await ctx.client.imps.create({ name: 'asleep' });
  await ctx.client.imps.sleep({ name: 'asleep' });

  const dead = await ctx.client.imps.get({ name: 'dead' });

  ctx.fake.alive.delete(1002);

  ctx.fake.control.agentReady = false;

  await ctx.imps.reconcileImps();

  const imps = await ctx.client.imps.list();

  expect(imps.map((imp) => [imp.name, imp.state])).toEqual([
    ['alive', 'running'],
    ['asleep', 'sleeping'],
    ['dead', 'stopped'],
  ]);

  expect(dead.state).toBe('running');
  expect(ctx.fake.stops).toEqual([]);
});

test('a read during a lifecycle operation does not mark the imp stopped', async () => {
  await using ctx = await setupTest(TOKEN);

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const gate = Promise.withResolvers<void>();

  ctx.fake.control.sleepGate = gate.promise;

  const sleeping = ctx.client.imps.sleep({ name: 'dev' });

  await Bun.sleep(5);

  // the VM looks dead to a reader while the sleep holds the lock
  ctx.fake.alive.clear();

  const during = await ctx.client.imps.get({ name: 'dev' });

  gate.resolve();

  const after = await sleeping;

  expect(during.state).toBe('running');
  expect(after.state).toBe('sleeping');
});

test('impd stopping closes exec sessions with 1012', async () => {
  await using ctx = await setupTest(TOKEN);

  const server = ctx.app.listen(0);

  try {
    const port = String(server.server?.port);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/exec?token=${TOKEN}`);

    const opened = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<CloseEvent>();

    socket.addEventListener('open', () => {
      opened.resolve();
    });

    socket.addEventListener('close', closed.resolve);

    await opened.promise;

    ctx.closeExecSessions();

    const event = await closed.promise;

    expect(event.code).toBe(1012);
  } finally {
    await server.stop(true);
  }
});
