import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ImpContract } from '@imp/api';
import { ORPCError, createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { buildApp } from './build-app';
import { loadConfig } from './config';
import { createImage } from './db/images';
import { openDatabase } from './db/open-database';
import type { ImpDatabase } from './db/open-database';
import { createImageService } from './images/image-service';
import { createImpService } from './imps/imp-service';
import type { VmRunner } from './vmm/vm-runner';

const TOKEN = 'test-token';

// a VM runner that boots instantly and tracks which pids are alive
function buildFakeVms() {
  const alive = new Set<number>();

  const stops: { pid: number; graceful: boolean }[] = [];
  let nextPid = 1000;

  const vms: VmRunner = {
    startVm: () => {
      nextPid += 1;

      alive.add(nextPid);

      return Promise.resolve({ pid: nextPid, firecrackerVersion: 'v1.17.0', timings: {} });
    },
    stopVm: (pid, _paths, graceful) => {
      alive.delete(pid);
      stops.push({ pid, graceful });

      return Promise.resolve();
    },
    isVmAlive: (pid) => alive.has(pid),
    isAgentReady: () => Promise.resolve(true),
  };

  return { vms, alive, stops };
}

async function setupTest(token: string) {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-test-`);

  const db = await openDatabase(':memory:');

  const config = loadConfig({ IMP_DATA_DIR: dataDir });
  const images = createImageService({ config, db });
  const fake = buildFakeVms();
  const taps: string[] = [];
  const logs: string[] = [];

  const imps = createImpService({
    config,
    db,
    images,
    vms: fake.vms,
    taps: {
      setupTap: (address) => {
        taps.push(address.tap);

        return Promise.resolve();
      },
      removeTap: () => Promise.resolve(),
    },
    log: (message) => {
      logs.push(message);
    },
    cloneDisk: (source, target) => {
      copyFileSync(source, target);

      return Promise.resolve();
    },
  });

  const app = buildApp({
    config,
    db,
    token: TOKEN,
    imps,
    images,
    firecrackerVersion: 'v1.17.0',
    isReady: () => true,
  });

  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: { authorization: `Bearer ${token}` },
    fetch: (request) => app.handle(request),
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(link);

  return {
    app,
    client,
    db,
    dataDir,
    fake,
    taps,
    async [Symbol.asyncDispose]() {
      await db.destroy();

      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// an image row whose rootfs is a small file in the test data dir
async function createFakeImage(db: ImpDatabase, dataDir: string, name: string) {
  await Bun.write(`${dataDir}/images/${name}/rootfs.ext4`, 'rootfs');

  return createImage(db, { name, ref: `${name}:latest`, digest: `sha256:${name}`, sizeBytes: 6 });
}

test('it serves system.info from config and the database', async () => {
  await using ctx = await setupTest(TOKEN);

  const info = await ctx.client.system.info();

  expect(info).toEqual({
    version: '0.0.0',
    ramBudgetMib: 16_384,
    ramUsedMib: 0,
    awakeCount: 0,
    impCount: 0,
    firecrackerVersion: 'v1.17.0',
    tailscale: { enabled: false, state: null, hostname: null },
  });
});

test('it answers an unbuilt procedure with NOT_IMPLEMENTED', async () => {
  await using ctx = await setupTest(TOKEN);

  const rejection = await ctx.client.imps.sleep({ name: 'dev' }).catch((error: unknown) => error);

  expect(rejection).toBeInstanceOf(ORPCError);
  expect(rejection).toMatchObject({ code: 'NOT_IMPLEMENTED', status: 501 });
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

  await createFakeImage(ctx.db, ctx.dataDir, 'ubuntu');

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
  expect(info).toMatchObject({ impCount: 1, awakeCount: 1, ramUsedMib: 2048 });

  await ctx.client.imps.destroy({ name: 'dev' });

  const imps = await ctx.client.imps.list();

  expect(imps).toEqual([]);
  expect(ctx.fake.alive.size).toBe(0);
});

test('it prefers the configured default image and falls back to ubuntu', async () => {
  await using ctx = await setupTest(TOKEN);

  await createFakeImage(ctx.db, ctx.dataDir, 'ubuntu');

  const first = await ctx.client.imps.create({ name: 'a' });

  await createFakeImage(ctx.db, ctx.dataDir, 'base');

  const second = await ctx.client.imps.create({});

  expect(first.image).toBe('ubuntu');
  expect(second.image).toBe('base');
  expect(second.name).toMatch(/^imp-[a-z0-9]{4}$/);
});

test('it rejects a duplicate name and an unknown image', async () => {
  await using ctx = await setupTest(TOKEN);

  await createFakeImage(ctx.db, ctx.dataDir, 'ubuntu');

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

  await createFakeImage(ctx.db, ctx.dataDir, 'ubuntu');

  await ctx.client.imps.create({ name: 'dev' });

  ctx.fake.alive.clear();

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.state).toBe('stopped');
});

test('it refuses to remove an image an imp uses', async () => {
  await using ctx = await setupTest(TOKEN);

  await createFakeImage(ctx.db, ctx.dataDir, 'ubuntu');

  await ctx.client.imps.create({ name: 'dev' });

  const rejection = await ctx.client.images
    .delete({ name: 'ubuntu' })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'CONFLICT' });
});
