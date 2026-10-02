import { expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { createImp, findImpByName, listImps, updateImpActivity, updateImpState } from '../db/imps';
import { buildImpPaths } from '../storage/data-layout';
import {
  buildTestApp,
  findBrokenInvariants,
  setupImpTest,
  waitForOutcome,
  writeTestSnapshot,
} from './test-imps';

// Whole-service tests through the oRPC router, with VM steps that fail, die
// or hang, and impd restarts over the same database and VMs.

async function setupLifecycleTest(env: Readonly<Record<string, string>> = {}) {
  const harness = await setupImpTest({ env });

  await harness.createTestImage('ubuntu');

  const app = buildTestApp(harness, harness);

  const findPaths = async (name: string) => {
    const imp = await findImpByName(harness.db, name);

    return buildImpPaths(harness.dataDir, imp?.id ?? '');
  };

  const readState = async (name: string) => {
    const imp = await findImpByName(harness.db, name);

    return imp?.state;
  };

  return { ...harness, client: app.client, findPaths, readState };
}

// polls `check` every millisecond for up to 2 s
async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;

  while (Date.now() < deadline) {
    const met = await check();

    if (met) {
      return;
    }

    await Bun.sleep(1);
  }

  throw new Error('the condition never held');
}

test('a restore waiting for admission does not deadlock the governor sleeping its imp', async () => {
  // a and x own 300 MiB each; b reserves 720, so admitting it must sleep
  // both, oldest first: x, then a. Once b is in, a's 256 still fits.
  await using ctx = await setupLifecycleTest({
    IMP_RAM_BUDGET_MIB: '1000',
    IMP_DEFAULT_MEMORY_MIB: '256',
    IMP_BOOT_RESERVE_PERCENT: '100',
  });

  const x = await ctx.client.imps.create({ name: 'x' });
  const a = await ctx.client.imps.create({ name: 'a' });
  const checkpoint = await ctx.client.checkpoints.create({ name: 'a' });

  await updateImpActivity(ctx.db, x.id, new Date(1000));
  await updateImpActivity(ctx.db, a.id, new Date(2000));

  const sleepGate = ctx.fake.hold('sleep');

  // the governor holds admission while x's sleep waits on the gate
  const admitting = ctx.client.imps.create({ name: 'b', memoryMib: 720 });

  await sleepGate.reached;

  // the restore takes a's lock, halts it, then waits for admission to boot it
  const restoring = ctx.client.checkpoints.restore({ name: 'a', checkpoint: checkpoint.id });

  await waitUntil(async () => (await ctx.readState('a')) === 'stopped');

  await Bun.sleep(20);

  sleepGate.release();

  const outcomes = await Promise.all([
    waitForOutcome(admitting, 2000),
    waitForOutcome(restoring, 2000),
  ]);

  // the governor skipped a, whose lock the restore held, instead of waiting
  const states = [await ctx.readState('x'), await ctx.readState('a')];

  expect(outcomes).toEqual(['done', 'done']);
  expect(states).toEqual(['sleeping', 'running']);

  await ctx.imps.waitForLifecycle();

  const broken = await findBrokenInvariants(ctx, false);

  expect(broken).toEqual([]);
});

test('a boot that fails leaves the imp in error with no VM and no reservation', async () => {
  await using ctx = await setupLifecycleTest();

  ctx.fake.queue('boot', 'fail');

  const rejection = await ctx.client.imps.create({ name: 'dev' }).catch((error: unknown) => error);
  const usage = await ctx.governor.readUsage();
  const broken = await findBrokenInvariants(ctx, false);
  const state = await ctx.readState('dev');

  expect(rejection).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(state).toBe('error');
  expect(usage).toEqual({ usedMib: 0, reservedMib: 0 });
  expect(broken).toEqual([]);
});

test('a VM that dies right after its boot is found stopped by the next read', async () => {
  await using ctx = await setupLifecycleTest();

  ctx.fake.queue('boot', 'die');

  const created = await ctx.client.imps.create({ name: 'dev' });
  const before = await findBrokenInvariants(ctx, false);

  // the read is the liveness pass
  const read = await ctx.client.imps.get({ name: 'dev' });
  const after = await findBrokenInvariants(ctx, true);

  expect(created.state).toBe('running');
  expect(before).toEqual([]);
  expect(read.state).toBe('stopped');
  expect(after).toEqual([]);
});

test('a failed wake falls back to a cold boot; a failed cold boot leaves an error', async () => {
  await using ctx = await setupLifecycleTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  ctx.fake.queue('wake', 'fail');

  const cold = await ctx.client.imps.wake({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  ctx.fake.queue('wake', 'fail');
  ctx.fake.queue('boot', 'fail');

  const rejection = await ctx.client.imps.wake({ name: 'dev' }).catch((error: unknown) => error);
  const broken = await findBrokenInvariants(ctx, false);
  const state = await ctx.readState('dev');

  expect(cold.state).toBe('running');
  expect(ctx.fake.wakes).toEqual([]);
  expect(rejection).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(state).toBe('error');
  expect(broken).toEqual([]);
});

// a asleep, b and c awake and held. A wake reserves 300 MiB and fits; a
// cold boot reserves all 512 and does not.
async function setupFullHost() {
  const ctx = await setupLifecycleTest({
    IMP_RAM_BUDGET_MIB: '900',
    IMP_DEFAULT_MEMORY_MIB: '512',
    IMP_BOOT_RESERVE_PERCENT: '100',
  });

  await ctx.client.imps.create({ name: 'a' });
  await ctx.client.imps.sleep({ name: 'a' });
  await ctx.client.imps.create({ name: 'b' });
  await ctx.client.imps.create({ name: 'c' });
  await ctx.client.imps.hold({ name: 'b', seconds: 600 });
  await ctx.client.imps.hold({ name: 'c', seconds: 600 });

  // past the boot reservations: b and c count what they measure
  ctx.advance(30_000);

  return ctx;
}

test('a failed wake whose cold boot the budget refuses drops the used snapshot', async () => {
  await using ctx = await setupFullHost();

  // the load ran the guest before the agent check failed
  ctx.fake.queue('wake', 'fail');

  const rejection = await ctx.client.imps.wake({ name: 'a' }).catch((error: unknown) => error);
  const paths = await ctx.findPaths('a');
  const state = await ctx.readState('a');
  const broken = await findBrokenInvariants(ctx, false);

  expect(rejection).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
  expect(state).toBe('stopped');
  expect(existsSync(paths.snapshotDir)).toBeFalse();
  expect(broken).toEqual([]);
});

test('a cold boot the budget refuses before anything loaded keeps the snapshot', async () => {
  await using ctx = await setupFullHost();

  const paths = await ctx.findPaths('a');

  writeTestSnapshot(paths, Date.now(), 'v0.1.0');

  const rejection = await ctx.client.imps.wake({ name: 'a' }).catch((error: unknown) => error);
  const state = await ctx.readState('a');
  const broken = await findBrokenInvariants(ctx, false);

  expect(rejection).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
  expect(state).toBe('sleeping');
  expect(existsSync(paths.snapshotMeta)).toBeTrue();
  expect(broken).toEqual([]);
});

test('a cold boot that fails after its admit releases the reservation', async () => {
  await using ctx = await setupLifecycleTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  writeTestSnapshot(paths, Date.now(), 'v0.1.0');

  ctx.fake.queue('boot', 'fail');

  const rejection = await ctx.client.imps.wake({ name: 'dev' }).catch((error: unknown) => error);
  const state = await ctx.readState('dev');
  const usage = await ctx.governor.readUsage();
  const broken = await findBrokenInvariants(ctx, false);

  expect(rejection).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(state).toBe('error');
  expect(usage).toEqual({ usedMib: 0, reservedMib: 0 });
  expect(broken).toEqual([]);
});

test('a snapshot that fails keeps the VM running; one lost after the kill stops the imp', async () => {
  await using ctx = await setupLifecycleTest();

  await ctx.client.imps.create({ name: 'dev' });

  ctx.fake.queue('sleep', 'fail');

  const kept = await ctx.client.imps.sleep({ name: 'dev' }).catch((error: unknown) => error);
  const afterFail = await ctx.readState('dev');

  ctx.fake.queue('sleep', 'die');

  const lost = await ctx.client.imps.sleep({ name: 'dev' }).catch((error: unknown) => error);
  const paths = await ctx.findPaths('dev');
  const broken = await findBrokenInvariants(ctx, false);
  const state = await ctx.readState('dev');

  expect(kept).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(afterFail).toBe('running');
  expect(lost).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(state).toBe('stopped');
  expect(existsSync(paths.snapshotDir)).toBeFalse();
  expect(broken).toEqual([]);
});

test('a restarted impd settles imps left in every state', async () => {
  await using ctx = await setupLifecycleTest();

  const names = [
    'alive',
    'dead',
    'dead-fresh-snapshot',
    'dead-old-snapshot',
    'asleep',
    'asleep-lost-snapshot',
    'stopped',
    'failed',
  ];

  for (const name of names) {
    await ctx.client.imps.create({ name });
  }

  const image = await ctx.images.resolveImage('ubuntu');

  // creates impd never finished: one whose VM still runs, one whose VM died
  const orphanPid = ctx.fake.spawnOrphan();

  const creatingLive = await createImp(ctx.db, {
    name: 'creating-live',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 20,
    ip: '10.66.0.40',
  });

  const creatingDead = await createImp(ctx.db, {
    name: 'creating-dead',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 21,
    ip: '10.66.0.41',
  });

  await updateImpState(ctx.db, creatingLive.id, { state: 'creating', pid: orphanPid });
  await updateImpState(ctx.db, creatingDead.id, { state: 'creating', pid: 99_999 });

  await ctx.client.imps.sleep({ name: 'asleep' });
  await ctx.client.imps.sleep({ name: 'asleep-lost-snapshot' });
  await ctx.client.imps.stop({ name: 'stopped' });

  ctx.fake.queue('boot', 'fail');

  await ctx.client.imps.stop({ name: 'failed' });
  await ctx.client.imps.start({ name: 'failed' }).catch(() => {});

  const imps = await listImps(ctx.db);

  const byName = new Map(imps.map((imp) => [imp.name, imp]));

  const removeVm = (name: string) => {
    ctx.fake.alive.delete(byName.get(name)?.pid ?? 0);
  };

  removeVm('dead');
  removeVm('dead-fresh-snapshot');
  removeVm('dead-old-snapshot');

  // a snapshot newer than the last activity was written by this VM's sleep;
  // an older one belongs to an earlier sleep
  const lastActive = byName.get('dead-fresh-snapshot')?.lastActiveAt.getTime() ?? 0;

  const fresh = await ctx.findPaths('dead-fresh-snapshot');
  const old = await ctx.findPaths('dead-old-snapshot');

  writeTestSnapshot(fresh, lastActive + 1000);
  writeTestSnapshot(old, lastActive - 1000);

  const lost = await ctx.findPaths('asleep-lost-snapshot');

  rmSync(lost.memFile);

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  // the old impd is gone: its VM calls never come back
  const replaced = await ctx.imps.listImps().catch((error: unknown) => error);
  const after = await listImps(ctx.db);

  const states = Object.fromEntries(after.map((imp) => [imp.name, imp.state]));

  const broken = await findBrokenInvariants(ctx, true);

  expect(states).toEqual({
    alive: 'running',
    dead: 'stopped',
    'dead-fresh-snapshot': 'sleeping',
    'dead-old-snapshot': 'stopped',
    asleep: 'sleeping',
    'asleep-lost-snapshot': 'stopped',
    stopped: 'stopped',
    failed: 'error',
    'creating-live': 'error',
    'creating-dead': 'error',
  });

  expect(ctx.fake.stops).toContainEqual({ pid: orphanPid, graceful: false });
  expect(replaced).toBeInstanceOf(Error);
  expect(broken).toEqual([]);
});

test('a creating imp whose VM will not stop does not keep the next impd from starting', async () => {
  await using ctx = await setupLifecycleTest();

  const image = await ctx.images.resolveImage('ubuntu');

  const pid = ctx.fake.spawnOrphan();

  const creating = await createImp(ctx.db, {
    name: 'stuck',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  await updateImpState(ctx.db, creating.id, { state: 'creating', pid });

  ctx.fake.queue('stop', 'fail');

  const impd = ctx.restartImpd();

  const reconciled = await waitForOutcome(impd.imps.reconcileImps(), 2000);
  const stuck = await findImpByName(ctx.db, 'stuck');
  const broken = await findBrokenInvariants(ctx, true);

  expect(reconciled).toBe('done');
  expect(stuck).toMatchObject({ state: 'error', pid });
  expect(broken).toEqual([]);

  // the record kept the pid, so a destroy kills the VM once it lets go
  await buildTestApp(ctx, impd).client.imps.destroy({ name: 'stuck' });

  expect(ctx.fake.alive.has(pid)).toBeFalse();
});

test('impd stopping with a wake under way leaves every imp asleep for the next impd', async () => {
  await using ctx = await setupLifecycleTest();

  await ctx.client.imps.create({ name: 'waking' });
  await ctx.client.imps.create({ name: 'running' });
  await ctx.client.imps.sleep({ name: 'waking' });

  const wakeGate = ctx.fake.hold('wake');
  const waking = ctx.client.imps.wake({ name: 'waking' });

  await wakeGate.reached;

  // SIGTERM: the wake under way finishes first, then everything sleeps
  const stopping = ctx.imps.sleepAllImps();

  wakeGate.release();

  const outcomes = await Promise.all([
    waitForOutcome(waking, 2000),
    waitForOutcome(stopping, 2000),
  ]);

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const after = await listImps(ctx.db);
  const broken = await findBrokenInvariants(ctx, true);

  expect(outcomes).toEqual(['done', 'done']);
  expect(after.map((imp) => imp.state)).toEqual(['sleeping', 'sleeping']);
  expect(ctx.fake.alive.size).toBe(0);
  expect(broken).toEqual([]);

  // the next impd wakes them as usual
  const next = buildTestApp(ctx, impd).client;

  const woken = await next.imps.wake({ name: 'waking' });

  expect(woken.state).toBe('running');
});

test('impd restarting in place waits for a boot under way and re-adopts its VM', async () => {
  await using ctx = await setupLifecycleTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  const bootGate = ctx.fake.hold('boot');
  const starting = ctx.client.imps.start({ name: 'dev' });

  await bootGate.reached;

  // SIGHUP: impd waits for lifecycle work, then execs itself; VMs stay up
  const waiting = { done: false };

  const lifecycle = (async () => {
    await ctx.imps.waitForLifecycle();

    waiting.done = true;
  })();

  await Bun.sleep(20);

  const doneWhileHeld = waiting.done;

  bootGate.release();

  await Promise.all([starting, lifecycle]);

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(doneWhileHeld).toBeFalse();
  expect(imp?.state).toBe('running');
  expect(ctx.fake.alive.has(imp?.pid ?? 0)).toBeTrue();
  expect(broken).toEqual([]);
});

test('an impd that dies mid-create leaves the next one an error record', async () => {
  await using ctx = await setupLifecycleTest();

  const bootGate = ctx.fake.hold('boot');
  const creating = ctx.client.imps.create({ name: 'dev' });

  await bootGate.reached;

  // impd is killed: the new one reconciles while the old boot is stuck
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  // the old boot finishes into a dead process and never writes its record
  bootGate.release();

  const outcome = await waitForOutcome(creating, 2000);
  const imp = await findImpByName(ctx.db, 'dev');

  expect(outcome).toBe('hung');
  expect(imp).toMatchObject({ state: 'error', pid: null });
});
