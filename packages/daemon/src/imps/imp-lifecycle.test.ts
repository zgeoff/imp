import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImp, findImpByName, listImps, updateImpActivity, updateImpState } from '../db/imps';
import { buildImpPaths } from '../storage/data-layout';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import {
  buildTestApp,
  createImpTest,
  findBrokenInvariants,
  waitForOutcome,
  writeTestSnapshot,
} from './test-imps';

// Whole-service tests through the oRPC router, with VM steps that fail, die
// or hang, and impd restarts over the same database and VMs.

async function setupTest(options: Readonly<{ env?: Readonly<Record<string, string>> }> = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, { env: options.env ?? {} });

  // every create boots this image
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

test(
  'it lets a restore waiting for admission past the governor sleeping its imp',
  async () => {
    // a and x own 300 MiB each; b reserves 720, so admitting it must sleep
    // both, oldest first: x, then a. Once b is in, a's 256 still fits.
    const ctx = await setupTest({
      env: {
        IMP_RAM_BUDGET_MIB: '1000',
        IMP_DEFAULT_MEMORY_MIB: '256',
        IMP_BOOT_RESERVE_PERCENT: '100',
      },
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

    await waitFor(async () => {
      const state = await ctx.readState('a');

      expect(state).toBe('stopped');
    });

    sleepGate.release();

    const admitted = await waitForOutcome(admitting, 10_000);
    const restored = await waitForOutcome(restoring, 10_000);

    await ctx.imps.waitForLifecycle();

    const xState = await ctx.readState('x');
    const aState = await ctx.readState('a');
    const broken = await findBrokenInvariants(ctx, false);

    expect(admitted).toBe('done');
    expect(restored).toBe('done');

    // the governor skipped a, whose lock the restore held, instead of waiting
    expect(xState).toBe('sleeping');
    expect(aState).toBe('running');
    expect(broken).toBeEmpty();
  },

  // a regression waits up to 10 s per held call; a loaded host is slow
  30_000,
);

test('it leaves an imp whose boot fails in error with no VM and no reservation', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('boot', 'fail');

  const creating = ctx.client.imps.create({ name: 'dev' });

  expect(creating).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const state = await ctx.readState('dev');
  const usage = await ctx.governor.readUsage();
  const broken = await findBrokenInvariants(ctx, false);

  expect(state).toBe('error');
  expect(usage).toStrictEqual({ usedMib: 0, reservedMib: 0, headroomMib: 0 });
  expect(broken).toBeEmpty();
});

test('it finds a VM that died right after its boot stopped on the next read', async () => {
  const ctx = await setupTest();

  ctx.fake.queue('boot', 'die');

  const created = await ctx.client.imps.create({ name: 'dev' });
  const before = await findBrokenInvariants(ctx, false);

  // the read is the liveness pass
  const read = await ctx.client.imps.get({ name: 'dev' });
  const after = await findBrokenInvariants(ctx, true);

  expect(created.state).toBe('running');
  expect(before).toBeEmpty();
  expect(read.state).toBe('stopped');
  expect(after).toBeEmpty();
});

test('it boots an imp cold when its wake fails', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  ctx.fake.queue('wake', 'fail');

  const cold = await ctx.client.imps.wake({ name: 'dev' });

  expect(ctx.fake.wakes).toBeEmpty();
  expect(ctx.fake.boots).toHaveLength(2);
  expect(cold.state).toBe('running');
});

test('it leaves an imp in error when its wake and the cold boot after it fail', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  ctx.fake.queue('wake', 'fail');
  ctx.fake.queue('boot', 'fail');

  const waking = ctx.client.imps.wake({ name: 'dev' });

  expect(waking).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const state = await ctx.readState('dev');
  const broken = await findBrokenInvariants(ctx, false);

  expect(state).toBe('error');
  expect(broken).toBeEmpty();
});

test('it drops the used snapshot when the budget refuses the cold boot after a failed wake', async () => {
  // a wake reserves 300 MiB and fits; a cold boot reserves all 512 and does not
  const ctx = await setupTest({
    env: {
      IMP_RAM_BUDGET_MIB: '900',
      IMP_DEFAULT_MEMORY_MIB: '512',
      IMP_BOOT_RESERVE_PERCENT: '100',
    },
  });

  await ctx.client.imps.create({ name: 'a' });
  await ctx.client.imps.sleep({ name: 'a' });
  await ctx.client.imps.create({ name: 'b' });
  await ctx.client.imps.create({ name: 'c' });
  await ctx.client.imps.hold({ name: 'b', seconds: 600 });
  await ctx.client.imps.hold({ name: 'c', seconds: 600 });

  // past the boot reservations: b and c count what they measure
  ctx.advance(30_000);

  // the load ran the guest before the agent check failed
  ctx.fake.queue('wake', 'fail');

  const waking = ctx.client.imps.wake({ name: 'a' });

  expect(waking).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  const paths = await ctx.findPaths('a');
  const state = await ctx.readState('a');
  const broken = await findBrokenInvariants(ctx, false);

  expect(state).toBe('stopped');
  expect(existsSync(paths.snapshotDir)).toBeFalse();
  expect(broken).toBeEmpty();
});

test('it keeps the snapshot when the budget refuses a cold boot before anything loaded', async () => {
  // a wake reserves 300 MiB and fits; a cold boot reserves all 512 and does not
  const ctx = await setupTest({
    env: {
      IMP_RAM_BUDGET_MIB: '900',
      IMP_DEFAULT_MEMORY_MIB: '512',
      IMP_BOOT_RESERVE_PERCENT: '100',
    },
  });

  await ctx.client.imps.create({ name: 'a' });
  await ctx.client.imps.sleep({ name: 'a' });
  await ctx.client.imps.create({ name: 'b' });
  await ctx.client.imps.create({ name: 'c' });
  await ctx.client.imps.hold({ name: 'b', seconds: 600 });
  await ctx.client.imps.hold({ name: 'c', seconds: 600 });

  // past the boot reservations: b and c count what they measure
  ctx.advance(30_000);

  const paths = await ctx.findPaths('a');

  // a snapshot an older Firecracker wrote can only boot cold
  writeTestSnapshot(paths, Date.now(), { ...ctx.readIdentity(), firecrackerVersion: 'v0.1.0' });

  const waking = ctx.client.imps.wake({ name: 'a' });

  expect(waking).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  const state = await ctx.readState('a');
  const broken = await findBrokenInvariants(ctx, false);

  expect(state).toBe('sleeping');
  expect(existsSync(paths.snapshotMeta)).toBeTrue();
  expect(broken).toBeEmpty();
});

test('it releases the reservation of a cold boot that fails after its admit', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  // a snapshot an older Firecracker wrote can only boot cold
  writeTestSnapshot(paths, Date.now(), { ...ctx.readIdentity(), firecrackerVersion: 'v0.1.0' });

  ctx.fake.queue('boot', 'fail');

  const waking = ctx.client.imps.wake({ name: 'dev' });

  expect(waking).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const state = await ctx.readState('dev');
  const usage = await ctx.governor.readUsage();
  const broken = await findBrokenInvariants(ctx, false);

  expect(state).toBe('error');
  expect(usage).toStrictEqual({ usedMib: 0, reservedMib: 0, headroomMib: 0 });
  expect(broken).toBeEmpty();
});

test('it keeps the VM running when its snapshot fails', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  ctx.fake.queue('sleep', 'fail');

  const sleeping = ctx.client.imps.sleep({ name: 'dev' });

  expect(sleeping).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const state = await ctx.readState('dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(state).toBe('running');
  expect(broken).toBeEmpty();
});

test('it stops the imp when its snapshot is lost after the kill', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  ctx.fake.queue('sleep', 'die');

  const sleeping = ctx.client.imps.sleep({ name: 'dev' });

  expect(sleeping).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const paths = await ctx.findPaths('dev');
  const state = await ctx.readState('dev');
  const broken = await findBrokenInvariants(ctx, false);

  expect(state).toBe('stopped');
  expect(existsSync(paths.snapshotDir)).toBeFalse();
  expect(broken).toBeEmpty();
});

test('it settles imps a restarted impd finds in every state', async () => {
  const ctx = await setupTest();

  for (const name of [
    'alive',
    'dead',
    'dead-fresh-snapshot',
    'dead-old-snapshot',
    'asleep',
    'asleep-lost-snapshot',
    'stopped',
    'failed',
  ]) {
    await ctx.client.imps.create({ name });
  }

  const image = await ctx.images.resolveImage('ubuntu');

  // creates impd never finished: one whose VM still runs, one whose VM died
  const orphanPid = ctx.fake.spawnOrphan();

  const creatingLive = await createImp(
    ctx.db,
    buildMockNewImp({ name: 'creating-live', imageId: image.id, slot: 20, ip: '10.66.0.40' }),
  );

  const creatingDead = await createImp(
    ctx.db,
    buildMockNewImp({ name: 'creating-dead', imageId: image.id, slot: 21, ip: '10.66.0.41' }),
  );

  await updateImpState(ctx.db, creatingLive.id, {
    reason: 'failed',
    state: 'creating',
    pid: orphanPid,
  });

  await updateImpState(ctx.db, creatingDead.id, {
    reason: 'failed',
    state: 'creating',
    pid: 99_999,
  });

  await ctx.client.imps.sleep({ name: 'asleep' });
  await ctx.client.imps.sleep({ name: 'asleep-lost-snapshot' });
  await ctx.client.imps.stop({ name: 'stopped' });

  ctx.fake.queue('boot', 'fail');

  await ctx.client.imps.stop({ name: 'failed' });
  await Promise.allSettled([ctx.client.imps.start({ name: 'failed' })]);

  const dead = await findImpByName(ctx.db, 'dead');
  const deadFresh = await findImpByName(ctx.db, 'dead-fresh-snapshot');
  const deadOld = await findImpByName(ctx.db, 'dead-old-snapshot');

  ctx.fake.alive.delete(dead?.pid ?? 0);
  ctx.fake.alive.delete(deadFresh?.pid ?? 0);
  ctx.fake.alive.delete(deadOld?.pid ?? 0);

  // a snapshot newer than the last activity was written by this VM's sleep;
  // an older one belongs to an earlier sleep
  const lastActive = deadFresh?.lastActiveAt.getTime() ?? 0;

  const fresh = await ctx.findPaths('dead-fresh-snapshot');
  const old = await ctx.findPaths('dead-old-snapshot');

  writeTestSnapshot(fresh, lastActive + 1000, ctx.readIdentity());
  writeTestSnapshot(old, lastActive - 1000, ctx.readIdentity());

  const lost = await ctx.findPaths('asleep-lost-snapshot');

  rmSync(lost.memFile);

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const after = await listImps(ctx.db);

  const states = Object.fromEntries(after.map((imp) => [imp.name, imp.state]));

  const broken = await findBrokenInvariants(ctx, true);

  expect(states).toStrictEqual({
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

  // the old impd is gone: its VM calls never come back
  expect(ctx.imps.listImps()).rejects.toThrow('this impd was replaced');
  expect(broken).toBeEmpty();
});

test(
  'it starts the next impd past a creating imp whose VM will not stop',
  async () => {
    const ctx = await setupTest();
    const image = await ctx.images.resolveImage('ubuntu');

    const pid = ctx.fake.spawnOrphan();

    const creating = await createImp(
      ctx.db,
      buildMockNewImp({ name: 'stuck', imageId: image.id, slot: 0, ip: '10.66.0.2' }),
    );

    await updateImpState(ctx.db, creating.id, { reason: 'failed', state: 'creating', pid });

    ctx.fake.queue('stop', 'fail');

    const impd = ctx.restartImpd();

    const reconciled = await waitForOutcome(impd.imps.reconcileImps(), 10_000);
    const stuck = await findImpByName(ctx.db, 'stuck');
    const broken = await findBrokenInvariants(ctx, true);

    expect(reconciled).toBe('done');
    expect(stuck).toMatchObject({ state: 'error', pid });
    expect(ctx.fake.alive.has(pid)).toBeTrue();
    expect(broken).toBeEmpty();
  },

  // a regression waits up to 10 s for the held start; a loaded host is slow
  30_000,
);

test('it kills the VM of a creating imp that would not stop once a destroy lets go', async () => {
  const ctx = await setupTest();
  const image = await ctx.images.resolveImage('ubuntu');

  const pid = ctx.fake.spawnOrphan();

  const creating = await createImp(
    ctx.db,
    buildMockNewImp({ name: 'stuck', imageId: image.id, slot: 0, ip: '10.66.0.2' }),
  );

  await updateImpState(ctx.db, creating.id, { reason: 'failed', state: 'creating', pid });

  ctx.fake.queue('stop', 'fail');

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  // the record kept the pid, so a destroy kills the VM
  await buildTestApp(ctx, impd).client.imps.destroy({ name: 'stuck' });

  expect(ctx.fake.alive.has(pid)).toBeFalse();
});

test(
  'it leaves every imp asleep for the next impd when impd stops with a wake under way',
  async () => {
    const ctx = await setupTest();

    await ctx.client.imps.create({ name: 'waking' });
    await ctx.client.imps.create({ name: 'running' });
    await ctx.client.imps.sleep({ name: 'waking' });

    const wakeGate = ctx.fake.hold('wake');
    const waking = ctx.client.imps.wake({ name: 'waking' });

    await wakeGate.reached;

    // SIGTERM: the wake under way finishes first, then everything sleeps
    const stopping = ctx.imps.sleepAllImps();

    wakeGate.release();

    const woke = await waitForOutcome(waking, 10_000);
    const stopped = await waitForOutcome(stopping, 10_000);

    const impd = ctx.restartImpd();

    await impd.imps.reconcileImps();

    const after = await listImps(ctx.db);
    const broken = await findBrokenInvariants(ctx, true);

    expect(woke).toBe('done');
    expect(stopped).toBe('done');
    expect(after.map((imp) => imp.state)).toStrictEqual(['sleeping', 'sleeping']);
    expect(ctx.fake.alive.size).toBe(0);
    expect(broken).toBeEmpty();
  },

  // a regression waits up to 10 s per held call; a loaded host is slow
  30_000,
);

test('it wakes an imp that impd stopping left asleep on the next impd', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'waking' });
  await ctx.client.imps.sleep({ name: 'waking' });

  const wakeGate = ctx.fake.hold('wake');
  const waking = ctx.client.imps.wake({ name: 'waking' });

  await wakeGate.reached;

  const stopping = ctx.imps.sleepAllImps();

  wakeGate.release();

  await Promise.all([waking, stopping]);

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const woken = await buildTestApp(ctx, impd).client.imps.wake({ name: 'waking' });

  expect(woken.state).toBe('running');
});

test('it re-adopts the VM of a boot under way once impd restarting in place waited for it', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  const bootGate = ctx.fake.hold('boot');
  const starting = ctx.client.imps.start({ name: 'dev' });

  await bootGate.reached;

  // SIGHUP: impd waits for lifecycle work, then execs itself; VMs stay up.
  // How many VMs run once the wait resolves: an early resolve sees none.
  const lifecycle = (async () => {
    await ctx.imps.waitForLifecycle();

    return ctx.fake.alive.size;
  })();

  bootGate.release();

  const vmsAtWaitEnd = await lifecycle;

  await starting;

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(vmsAtWaitEnd).toBe(1);
  expect(imp?.state).toBe('running');
  expect(ctx.fake.alive.has(imp?.pid ?? 0)).toBeTrue();
  expect(broken).toBeEmpty();
});

test('it leaves the next impd an error record when impd dies mid-create', async () => {
  const ctx = await setupTest();

  const bootGate = ctx.fake.hold('boot');
  const creating = ctx.client.imps.create({ name: 'dev' });

  await bootGate.reached;

  // impd is killed: the new one reconciles while the old boot is stuck
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  // the old boot finishes into a dead process: its VM starts, and the call
  // never comes back to write its record
  bootGate.release();

  await waitFor(() => {
    expect(ctx.fake.alive.size).toBe(1);
  });

  const imp = await findImpByName(ctx.db, 'dev');

  expect(Bun.peek.status(creating)).toBe('pending');
  expect(imp).toMatchObject({ state: 'error', pid: null });
});
