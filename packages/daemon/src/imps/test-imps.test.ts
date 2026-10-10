import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { runChildTests } from '@imp/test-utils/run-child-tests';
import { waitFor } from '@imp/test-utils/wait-for';
import { listImps } from '../db/imps';
import { hasSnapshot, readSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import {
  buildTestApp,
  createImpTest,
  findBrokenInvariants,
  setupImpTest,
  waitForOutcome,
  writeTestSnapshot,
} from './test-imps';

test('#setupImpTest boots imps on the stub VMM', async () => {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  const [imp] = await listImps(ctx.db);

  invariant(imp?.pid);

  expect(imp.state).toBe('running');
  expect(ctx.fake.alive.has(imp.pid)).toBeTrue();
});

test('#setupImpTest re-adopts a running VM after restartImpd', async () => {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  const [before] = await listImps(ctx.db);

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const [after] = await listImps(ctx.db);

  invariant(before);

  expect(after).toMatchObject({ state: 'running', pid: before.pid });
});

test('#setupImpTest removes its data dir and closes its database on release', async () => {
  const ctx = await setupImpTest();

  await ctx[Symbol.asyncDispose]();

  expect(existsSync(ctx.dataDir)).toBeFalse();
  expect(listImps(ctx.db)).rejects.toThrow();
});

test('#setupImpTest removes its data dir when the test finishes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'test-imps-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const run = runChildTests(
    dir,
    [
      "import { expect, test } from 'bun:test';",
      "import { existsSync } from 'node:fs';",
      `import { setupImpTest } from ${JSON.stringify(join(import.meta.dir, 'test-imps.ts'))};`,
      "const left = { dataDir: '' };",
      "test('it sets up', async () => { left.dataDir = (await setupImpTest()).dataDir; });",
      "test('it finds the data dir gone', () => { expect(existsSync(left.dataDir)).toBeFalse(); });",
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 2 pass');
});

test('#setupImpTest lets the test end release it again after an explicit release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'test-imps-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  // a second release that threw would fail the child's test
  const run = runChildTests(
    dir,
    [
      "import { test } from 'bun:test';",
      `import { setupImpTest } from ${JSON.stringify(join(import.meta.dir, 'test-imps.ts'))};`,
      "test('it releases early', async () => { await (await setupImpTest())[Symbol.asyncDispose](); });",
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 1 pass');
});

test('#setupImpTest removes its data dir when a setup step throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'test-imps-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const run = runChildTests(
    dir,
    [
      "import { expect, test } from 'bun:test';",
      "import { existsSync } from 'node:fs';",
      `import { setupImpTest } from ${JSON.stringify(join(import.meta.dir, 'test-imps.ts'))};`,
      'const seen: string[] = [];',
      "test('it fails to set up', () => {",
      '  const setup = setupImpTest({',
      "    createStorage: (dataDir) => { seen.push(dataDir); throw new Error('no storage'); },",
      '  });',
      "  expect(setup).rejects.toThrow('no storage');",
      '});',
      "test('it finds the data dir gone', () => {",
      '  expect(seen.map((dataDir) => existsSync(dataDir))).toStrictEqual([false]);',
      '});',
    ].join('\n'),
  );

  expect(run.exitCode).toBe(0);
  expect(run.output).toInclude(' 2 pass');
});

test('#setupImpTest keeps a data dir the caller passed', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'test-imps-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  const ctx = await setupImpTest({ dataDir });

  await ctx[Symbol.asyncDispose]();

  expect(existsSync(dataDir)).toBeTrue();
});

test('#createImpTest has its data dir removed by the stack after a setup step throws', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const seen: string[] = [];

  const setup = createImpTest(stack, {
    createStorage: (dataDir) => {
      seen.push(dataDir);
      throw new Error('no storage');
    },
  });

  expect(setup).rejects.toThrowWithMessage(Error, 'no storage');

  await stack.disposeAsync();

  expect(seen.map((dataDir) => existsSync(dataDir))).toStrictEqual([false]);
});

test('#createImpTest finishes a running template build before it removes its data dir', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const logs: string[] = [];

  const harness = await createImpTest(stack, {
    env: { IMP_BOOT_TEMPLATES: 'true' },
    onLog: (message) => {
      logs.push(message);
    },
  });

  await harness.createTestImage('ubuntu');

  const held = harness.fake.hold('template');

  // the first release once the stack unwinds; the harness's own wait
  // for the build comes after it
  stack.defer(() => {
    held.release();
  });

  // the second boot of a shape builds its template in the background
  await harness.imps.createImp({ name: 'once', vcpus: 1, memoryMib: 256 });
  await harness.imps.createImp({ name: 'first', vcpus: 1, memoryMib: 256 });

  await held.reached;

  await stack.disposeAsync();

  const builtAt = logs.findIndex((line) => /^impd: boot template \w+ built in/u.test(line));

  expect(builtAt).toBeGreaterThanOrEqual(0);
  expect(builtAt).toBeLessThan(logs.indexOf('test harness: database closed'));
  expect(existsSync(harness.dataDir)).toBeFalse();
});

test('#createImpTest releases a hung template build before it waits for the build', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, { env: { IMP_BOOT_TEMPLATES: 'true' } });

  await harness.createTestImage('ubuntu');

  harness.fake.queue('template', 'hang');

  // the second boot of a shape builds its template in the background
  await harness.imps.createImp({ name: 'once', vcpus: 1, memoryMib: 256 });
  await harness.imps.createImp({ name: 'first', vcpus: 1, memoryMib: 256 });

  await waitFor(() => {
    expect(harness.fake.countHungCalls()).toBe(1);
  });

  await stack.disposeAsync();

  expect(existsSync(harness.dataDir)).toBeFalse();
});

test('#createImpTest never waits for the template build of an impd that restartImpd replaced', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, { env: { IMP_BOOT_TEMPLATES: 'true' } });

  await harness.createTestImage('ubuntu');

  const held = harness.fake.hold('template');

  stack.defer(() => {
    held.release();
  });

  // the second boot of a shape builds its template in the background
  await harness.imps.createImp({ name: 'once', vcpus: 1, memoryMib: 256 });
  await harness.imps.createImp({ name: 'first', vcpus: 1, memoryMib: 256 });

  await held.reached;

  // the build's VM call comes back to a replaced impd, so it parks
  harness.restartImpd();
  held.release();

  await waitFor(() => {
    expect(harness.fake.countParkedCalls()).toBe(1);
  });

  await stack.disposeAsync();

  expect(existsSync(harness.dataDir)).toBeFalse();
});

test('#buildTestApp serves the API over the harness', async () => {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  const app = buildTestApp(ctx, ctx);

  const imps = await app.client.imps.list({});

  expect(imps.map((imp) => imp.name)).toStrictEqual(['dev']);
});

test('#setupImpTest moves a frozen clock when the test advances it', async () => {
  const ctx = await setupImpTest({ frozenClockMs: 1_000_000 });

  ctx.advance(500);

  expect(ctx.now()).toBe(1_000_500);
});

test('#setupImpTest moves a frozen clock by the pauses of a young guest wait', async () => {
  const ctx = await setupImpTest({
    env: { IMP_SLEEP_MIN_GUEST_UPTIME_MS: '300' },
    frozenClockMs: 1_000_000,
  });

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  // 100 ms old against a 300 ms minimum
  ctx.fake.setGuestUptime(100);

  await ctx.imps.sleepImp('dev');

  expect(ctx.now()).toBe(1_000_200);
});

test('#findBrokenInvariants finds nothing wrong with a running imp and its VM', async () => {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  const broken = await findBrokenInvariants(ctx, true);

  expect(broken).toStrictEqual([]);
});

test('#findBrokenInvariants reports a VM that runs for no running imp', async () => {
  const ctx = await setupImpTest();

  const pid = ctx.fake.spawnOrphan();

  const broken = await findBrokenInvariants(ctx, true);

  expect(broken).toStrictEqual([`VM ${String(pid)} runs for no running imp`]);
});

test('#findBrokenInvariants reports a running imp whose VM died once liveness ran', async () => {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  const [imp] = await listImps(ctx.db);

  invariant(imp?.pid);

  ctx.fake.alive.delete(imp.pid);

  const broken = await findBrokenInvariants(ctx, true);

  expect(broken).toStrictEqual(['dev (running): its VM is dead']);
});

test('#writeTestSnapshot writes the files and the meta a wake loads', async () => {
  const ctx = await setupImpTest();

  const paths = buildImpPaths(ctx.dataDir, 'imp-a');

  writeTestSnapshot(paths, 1234, {
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: 'test',
    guestKernel: 'k',
    systemDrive: 'd1',
  });

  expect(hasSnapshot(paths)).toBeTrue();

  expect(readSnapshotMeta(paths)).toStrictEqual({
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: 'test',
    guestKernel: 'k',
    systemDrive: 'd1',
    createdAt: 1234,
    memoryMib: 2048,
    ramMib: 300,
  });
});

test('#waitForOutcome reports done for a promise that resolves', async () => {
  const outcome = await waitForOutcome(Promise.resolve('fine'), 1000);

  expect(outcome).toBe('done');
});

test('#waitForOutcome reports failed for a promise that rejects', async () => {
  const outcome = await waitForOutcome(Promise.reject(new Error('boom')), 1000);

  expect(outcome).toBe('failed');
});

test('#waitForOutcome reports hung for a promise still pending at its deadline', async () => {
  const clock = { nowMs: 0 };

  const outcome = await waitForOutcome(new Promise(() => {}), 1000, {
    now: () => clock.nowMs,
    wait: (ms) => {
      clock.nowMs += ms;

      return Promise.resolve();
    },
  });

  expect(outcome).toBe('hung');
});
