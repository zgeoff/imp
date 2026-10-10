import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { listImps } from '../db/imps';
import { hasSnapshot, readSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import { StubVmError } from '../test-utils/build-stub-vmm';
import {
  buildTestApp,
  createImpTest,
  findBrokenInvariants,
  waitForOutcome,
  writeTestSnapshot,
} from './test-imps';

test('#createImpTest boots imps on the stub VMM', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await harness.createTestImage('ubuntu');
  await harness.imps.createImp({ name: 'dev' });

  const [imp] = await listImps(harness.db);

  invariant(imp?.pid);

  expect(imp.state).toBe('running');
  expect(harness.fake.alive.has(imp.pid)).toBeTrue();
});

test('#createImpTest re-adopts a running VM after restartImpd', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await harness.createTestImage('ubuntu');
  await harness.imps.createImp({ name: 'dev' });

  const [before] = await listImps(harness.db);

  const impd = harness.restartImpd();

  await impd.imps.reconcileImps();

  const [after] = await listImps(harness.db);

  invariant(before);

  expect(after).toMatchObject({ state: 'running', pid: before.pid });
});

test('#createImpTest has its data dir removed by the stack', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await stack.disposeAsync();

  expect(existsSync(harness.dataDir)).toBeFalse();
});

test('#createImpTest has its database closed by the stack', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await stack.disposeAsync();

  expect(listImps(harness.db)).rejects.toThrow();
});

test('#createImpTest keeps a data dir the caller passed', async () => {
  // registered first, so the impd stops before its data dir goes
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'test-imps-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  await createImpTest(stack, { dataDir });

  await stack.disposeAsync();

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

test('#createImpTest finishes the template build of a replaced impd that got past its VM call', async () => {
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

  // the second boot of a shape builds its template in the background
  await harness.imps.createImp({ name: 'once', vcpus: 1, memoryMib: 256 });
  await harness.imps.createImp({ name: 'first', vcpus: 1, memoryMib: 256 });

  await waitFor(() => {
    expect(harness.fake.templateBuilds).toHaveLength(1);
  });

  // the build's VM call came back to a live impd, so the rest of it runs
  harness.restartImpd();

  await stack.disposeAsync();

  const builtAt = logs.findIndex((line) => /^impd: boot template \w+ built in/u.test(line));

  expect(builtAt).toBeGreaterThanOrEqual(0);
  expect(builtAt).toBeLessThan(logs.indexOf('test harness: database closed'));
  expect(existsSync(harness.dataDir)).toBeFalse();
});

test('#buildTestApp serves the API over the harness', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await harness.createTestImage('ubuntu');
  await harness.imps.createImp({ name: 'dev' });

  const app = buildTestApp(harness, harness);

  const imps = await app.client.imps.list({});

  expect(imps.map((imp) => imp.name)).toStrictEqual(['dev']);
});

test('#buildTestApp records an unexpected RPC failure in the harness', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);

  harness.fake.queue('boot', 'fail');

  expect(app.client.imps.create({ name: 'dev' })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });

  expect(harness.rpcFailures).toStrictEqual([expect.any(StubVmError)]);
});

test('#buildTestApp logs an unexpected RPC failure to the harness log', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);

  harness.fake.queue('boot', 'fail');

  expect(app.client.imps.create({ name: 'dev' })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });

  expect(harness.logs).toSatisfyAny(
    (line: string) =>
      line.startsWith('impd: rpc failed: ') && line.includes('StubVmError: boot failed: no agent'),
  );
});

test('#buildTestApp records no failure the API returns as an expected error', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  const app = buildTestApp(harness, harness);

  expect(app.client.imps.get({ name: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(harness.rpcFailures).toBeEmpty();
});

test('#createImpTest moves a frozen clock when the test advances it', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, { frozenClockMs: 1_000_000 });

  harness.advance(500);

  expect(harness.now()).toBe(1_000_500);
});

test('#createImpTest moves a frozen clock by the pauses of a young guest wait', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, {
    env: { IMP_SLEEP_MIN_GUEST_UPTIME_MS: '300' },
    frozenClockMs: 1_000_000,
  });

  await harness.createTestImage('ubuntu');
  await harness.imps.createImp({ name: 'dev' });

  // 100 ms old against a 300 ms minimum
  harness.fake.setGuestUptime(100);

  await harness.imps.sleepImp('dev');

  expect(harness.now()).toBe(1_000_200);
});

test('#findBrokenInvariants finds nothing wrong with a running imp and its VM', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await harness.createTestImage('ubuntu');
  await harness.imps.createImp({ name: 'dev' });

  const broken = await findBrokenInvariants(harness, true);

  expect(broken).toStrictEqual([]);
});

test('#findBrokenInvariants reports a VM that runs for no running imp', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  const pid = harness.fake.spawnOrphan();

  const broken = await findBrokenInvariants(harness, true);

  expect(broken).toStrictEqual([`VM ${String(pid)} runs for no running imp`]);
});

test('#findBrokenInvariants reports a running imp whose VM died once liveness ran', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await harness.createTestImage('ubuntu');
  await harness.imps.createImp({ name: 'dev' });

  const [imp] = await listImps(harness.db);

  invariant(imp?.pid);

  harness.fake.alive.delete(imp.pid);

  const broken = await findBrokenInvariants(harness, true);

  expect(broken).toStrictEqual(['dev (running): its VM is dead']);
});

test('#writeTestSnapshot writes the files and the meta a wake loads', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  const paths = buildImpPaths(harness.dataDir, 'imp-a');

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
