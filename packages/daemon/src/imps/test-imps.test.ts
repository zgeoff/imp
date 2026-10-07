import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { listImps } from '../db/imps';
import { hasSnapshot, readSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import { buildTestApp, findBrokenInvariants, setupImpTest, writeTestSnapshot } from './test-imps';

test('#setupImpTest boots imps on the stub VMM', async () => {
  await using ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  const [imp] = await listImps(ctx.db);

  invariant(imp?.pid);

  expect(imp.state).toBe('running');
  expect(ctx.fake.alive.has(imp.pid)).toBeTrue();
});

test('#setupImpTest re-adopts a running VM after restartImpd', async () => {
  await using ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  const [before] = await listImps(ctx.db);

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const [after] = await listImps(ctx.db);

  invariant(before);

  expect(after).toMatchObject({ state: 'running', pid: before.pid });
});

test('#setupImpTest removes its data dir and closes its database on dispose', async () => {
  const ctx = await setupImpTest();

  await ctx[Symbol.asyncDispose]();

  expect(existsSync(ctx.dataDir)).toBeFalse();
  expect(listImps(ctx.db)).rejects.toThrow();
});

test('#setupImpTest keeps a data dir the caller passed', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'test-imps-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  const ctx = await setupImpTest({ dataDir });

  await ctx[Symbol.asyncDispose]();

  expect(existsSync(dataDir)).toBeTrue();
});

test('#setupImpTest removes its data dir when a setup step throws', async () => {
  const seen: string[] = [];

  const setup = setupImpTest({
    createStorage: (dataDir) => {
      seen.push(dataDir);
      throw new Error('no storage');
    },
  });

  await setup.catch(() => {});

  expect(setup).rejects.toThrowWithMessage(Error, 'no storage');
  expect(seen.map((dataDir) => existsSync(dataDir))).toStrictEqual([false]);
});

test('#buildTestApp serves the API over the harness', async () => {
  await using ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  const app = buildTestApp(ctx, ctx);

  const imps = await app.client.imps.list({});

  expect(imps.map((imp) => imp.name)).toStrictEqual(['dev']);
});

test('#setupImpTest moves a frozen clock only when the test advances it', async () => {
  await using ctx = await setupImpTest({ frozenClockMs: 1_000_000 });

  ctx.advance(500);

  expect(ctx.now()).toBe(1_000_500);
});

test('#findBrokenInvariants finds nothing wrong with a running imp and its VM', async () => {
  await using ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  const broken = await findBrokenInvariants(ctx, true);

  expect(broken).toStrictEqual([]);
});

test('#findBrokenInvariants reports a VM that runs for no running imp', async () => {
  await using ctx = await setupImpTest();

  const pid = ctx.fake.spawnOrphan();

  const broken = await findBrokenInvariants(ctx, true);

  expect(broken).toStrictEqual([`VM ${String(pid)} runs for no running imp`]);
});

test('#findBrokenInvariants reports a running imp whose VM died once liveness ran', async () => {
  await using ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  const [imp] = await listImps(ctx.db);

  invariant(imp?.pid);

  ctx.fake.alive.delete(imp.pid);

  const broken = await findBrokenInvariants(ctx, true);

  expect(broken).toStrictEqual(['dev (running): its VM is dead']);
});

test('#writeTestSnapshot writes the files and the meta a wake loads', async () => {
  await using ctx = await setupImpTest();

  const paths = buildImpPaths(ctx.dataDir, 'imp-a');

  writeTestSnapshot(paths, 1234, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: 'test',
    guestKernel: 'k',
    systemDrive: 'd1',
  });

  expect({ isLoadable: hasSnapshot(paths), meta: readSnapshotMeta(paths) }).toStrictEqual({
    isLoadable: true,
    meta: {
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: 'test',
      guestKernel: 'k',
      systemDrive: 'd1',
      createdAt: 1234,
      memoryMib: 2048,
      ramMib: 300,
    },
  });
});
