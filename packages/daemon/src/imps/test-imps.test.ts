import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { listImps } from '../db/imps';
import { buildTestApp, setupImpTest } from './test-imps';

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
