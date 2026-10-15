import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { invariant } from '@impz/test-utils/invariant';
import { waitFor } from '@impz/test-utils/wait-for';
import fc from 'fast-check';
import { createImp, findImpByName, listImps, updateImpActivity, updateImpState } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { readSnapshotMeta, writeSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import { StubVmError } from '../test-utils/build-stub-vmm';
import type { VmOutcome } from '../test-utils/build-stub-vmm';
import { runWithStack } from '../test-utils/run-with-stack';
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

  return { ...harness, client: app.client };
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
      const halted = await findImpByName(ctx.db, 'a');

      expect(halted?.state).toBe('stopped');
    });

    sleepGate.release();

    const admitted = await waitForOutcome(admitting, 10_000);
    const restored = await waitForOutcome(restoring, 10_000);

    await ctx.imps.waitForLifecycle();

    const xAfter = await findImpByName(ctx.db, 'x');
    const aAfter = await findImpByName(ctx.db, 'a');
    const broken = await findBrokenInvariants(ctx, false);

    expect(admitted).toBe('done');
    expect(restored).toBe('done');

    // the governor skipped a, whose lock the restore held, instead of waiting
    expect(xAfter?.state).toBe('sleeping');
    expect(aAfter?.state).toBe('running');
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

  const imp = await findImpByName(ctx.db, 'dev');
  const usage = await ctx.governor.readUsage();
  const broken = await findBrokenInvariants(ctx, false);

  expect(imp?.state).toBe('error');
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

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, false);

  expect(imp?.state).toBe('error');
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

  const a = await ctx.client.imps.create({ name: 'a' });

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

  const paths = buildImpPaths(ctx.dataDir, a.id);

  const imp = await findImpByName(ctx.db, 'a');
  const broken = await findBrokenInvariants(ctx, false);

  expect(imp?.state).toBe('stopped');
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

  const a = await ctx.client.imps.create({ name: 'a' });

  await ctx.client.imps.sleep({ name: 'a' });
  await ctx.client.imps.create({ name: 'b' });
  await ctx.client.imps.create({ name: 'c' });
  await ctx.client.imps.hold({ name: 'b', seconds: 600 });
  await ctx.client.imps.hold({ name: 'c', seconds: 600 });

  // past the boot reservations: b and c count what they measure
  ctx.advance(30_000);

  const paths = buildImpPaths(ctx.dataDir, a.id);

  // a snapshot an older Firecracker wrote can only boot cold
  writeTestSnapshot(paths, Date.now(), { ...ctx.readIdentity(), firecrackerVersion: 'v0.1.0' });

  const waking = ctx.client.imps.wake({ name: 'a' });

  expect(waking).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  const imp = await findImpByName(ctx.db, 'a');
  const broken = await findBrokenInvariants(ctx, false);

  expect(imp?.state).toBe('sleeping');
  expect(existsSync(paths.snapshotMeta)).toBeTrue();
  expect(broken).toBeEmpty();
});

test('it releases the reservation of a cold boot that fails after its admit', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  // a snapshot an older Firecracker wrote can only boot cold
  writeTestSnapshot(paths, Date.now(), { ...ctx.readIdentity(), firecrackerVersion: 'v0.1.0' });

  ctx.fake.queue('boot', 'fail');

  const waking = ctx.client.imps.wake({ name: 'dev' });

  expect(waking).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const imp = await findImpByName(ctx.db, 'dev');
  const usage = await ctx.governor.readUsage();
  const broken = await findBrokenInvariants(ctx, false);

  expect(imp?.state).toBe('error');
  expect(usage).toStrictEqual({ usedMib: 0, reservedMib: 0, headroomMib: 0 });
  expect(broken).toBeEmpty();
});

test('it keeps the VM running when its snapshot fails', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  ctx.fake.queue('sleep', 'fail');

  const sleeping = ctx.client.imps.sleep({ name: 'dev' });

  expect(sleeping).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(imp?.state).toBe('running');
  expect(broken).toBeEmpty();
});

test('it stops the imp when its snapshot is lost after the kill', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  ctx.fake.queue('sleep', 'die');

  const sleeping = ctx.client.imps.sleep({ name: 'dev' });

  expect(sleeping).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, false);

  expect(imp?.state).toBe('stopped');
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
    buildMockNewImp({ name: 'creating-live', imageId: image.id, slot: 20, ip: '10.66.0.82' }),
  );

  const creatingDead = await createImp(
    ctx.db,
    buildMockNewImp({ name: 'creating-dead', imageId: image.id, slot: 21, ip: '10.66.0.86' }),
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
  const lostSnapshot = await findImpByName(ctx.db, 'asleep-lost-snapshot');

  invariant(dead?.pid);
  invariant(deadFresh?.pid);
  invariant(deadOld?.pid);
  invariant(lostSnapshot);

  ctx.fake.alive.delete(dead.pid);
  ctx.fake.alive.delete(deadFresh.pid);
  ctx.fake.alive.delete(deadOld.pid);

  // a snapshot newer than the last activity was written by this VM's sleep;
  // an older one belongs to an earlier sleep
  const lastActive = deadFresh.lastActiveAt.getTime();

  writeTestSnapshot(
    buildImpPaths(ctx.dataDir, deadFresh.id),
    lastActive + 1000,
    ctx.readIdentity(),
  );

  writeTestSnapshot(buildImpPaths(ctx.dataDir, deadOld.id), lastActive - 1000, ctx.readIdentity());
  rmSync(buildImpPaths(ctx.dataDir, lostSnapshot.id).memFile);

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
  // parks without coming back to write its record
  bootGate.release();

  await waitFor(() => {
    expect(ctx.fake.countParkedCalls()).toBe(1);
  });

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.alive.size).toBe(1);
  expect(Bun.peek.status(creating)).toBe('pending');
  expect(imp).toMatchObject({ state: 'error', pid: null });
});

test(
  'it leaves consistent records after concurrent lifecycle calls on a few imps',
  async () => {
    const nameArb = fc.constantFrom('a', 'b', 'c', 'd');

    // holds come often: only with imps pinned does the budget turn calls away
    const opArb = fc.oneof(
      { arbitrary: fc.record({ kind: fc.constant('hold' as const), name: nameArb }), weight: 2 },
      fc.record({
        kind: fc.constantFrom(
          'create' as const,
          'sleep' as const,
          'wake' as const,
          'start' as const,
          'stop' as const,
          'restore' as const,
          'destroy' as const,
          'crash' as const,
          'outdate' as const,
        ),
        name: nameArb,
      }),
      fc.record({ kind: fc.constantFrom('enforce' as const, 'tick' as const, 'sigterm' as const) }),
    );

    const outcomeArb: fc.Arbitrary<VmOutcome> = fc.oneof(
      { arbitrary: fc.constant('ok' as const), weight: 2 },
      { arbitrary: fc.constantFrom('fail' as const, 'die' as const, 'hang' as const), weight: 1 },
    );

    // the outcomes each step's next calls take, in order
    const scriptArb = fc.record({
      boot: fc.array(outcomeArb, { maxLength: 4 }),
      wake: fc.array(outcomeArb, { maxLength: 4 }),
      sleep: fc.array(outcomeArb, { maxLength: 4 }),
      stop: fc.array(outcomeArb, { maxLength: 4 }),
      agentReady: fc.array(outcomeArb, { maxLength: 4 }),
    });

    // a failure reports fast-check's seed, path and shrunk counterexample
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(opArb, { minLength: 4, maxLength: 16 }),
        scriptArb,

        // each case releases its impd before the next, pass or fail
        (scheduler, ops, script) =>
          runWithStack(async (stack) => {
            // each governor sleep, with whether the imp was held when it went;
            // the read queues before the sleep's own record update, under its lock
            const governorSleeps: Promise<{ readonly name: string; readonly held: boolean }>[] = [];

            const holder: { db: ImpDatabase | null; now: () => number } = {
              db: null,
              now: Date.now,
            };

            const readSleep = async (name: string, at: number) => {
              const imp = holder.db === null ? undefined : await findImpByName(holder.db, name);
              const holdUntil = imp?.holdUntil?.getTime() ?? 0;

              return { name, held: holdUntil > at };
            };

            const ctx = await createImpTest(stack, {
              // 300 MiB per awake stub VM, 410 reserved per boot or wake: with
              // two imps awake a third makes the governor sleep one, and holds
              // leave it none
              env: {
                IMP_RAM_BUDGET_MIB: '900',
                IMP_DEFAULT_MEMORY_MIB: '512',
                IMP_BOOT_RESERVE_PERCENT: '80',
                IMP_WAKE_RESERVE_MIB: '410',
              },

              // a sleep the governor did, as impd logs it
              onLog: (message) => {
                const match =
                  /^impd: (?<name>\S+): asleep in \d+ms \((?:to make room for \S+|RAM over budget)\)/.exec(
                    message,
                  );

                const name = match?.groups?.['name'];

                if (name !== undefined) {
                  governorSleeps.push(readSleep(name, holder.now()));
                }
              },
            });

            holder.db = ctx.db;
            holder.now = ctx.now;

            await ctx.createTestImage('ubuntu');

            const client = buildTestApp(ctx, ctx).client;

            // c asleep, a and b awake, d not created yet; each has a checkpoint
            await client.imps.create({ name: 'c' });
            await client.checkpoints.create({ name: 'c', label: 'base' });
            await client.imps.sleep({ name: 'c' });
            await client.imps.create({ name: 'a' });
            await client.checkpoints.create({ name: 'a', label: 'base' });
            await client.imps.create({ name: 'b' });
            await client.checkpoints.create({ name: 'b', label: 'base' });

            ctx.fake.queue('boot', ...script.boot);
            ctx.fake.queue('wake', ...script.wake);
            ctx.fake.queue('sleep', ...script.sleep);
            ctx.fake.queue('stop', ...script.stop);
            ctx.fake.queue('agentReady', ...script.agentReady);
            ctx.fake.setPace(() => scheduler.schedule(Promise.resolve()));

            // the interpreter: each generated op through the API or, for a
            // host event, through the stand-in that impd reads it from
            const runOp = async (op: (typeof ops)[number]): Promise<void> => {
              switch (op.kind) {
                case 'create': {
                  await client.imps.create({ name: op.name });

                  break;
                }
                case 'sleep': {
                  await client.imps.sleep({ name: op.name });

                  break;
                }
                case 'wake': {
                  await client.imps.wake({ name: op.name });

                  break;
                }
                case 'start': {
                  await client.imps.start({ name: op.name });

                  break;
                }
                case 'stop': {
                  await client.imps.stop({ name: op.name });

                  break;
                }
                case 'restore': {
                  await client.checkpoints.restore({ name: op.name, checkpoint: 'base' });

                  break;
                }
                case 'hold': {
                  await client.imps.hold({ name: op.name, seconds: 30 });

                  break;
                }
                case 'destroy': {
                  await client.imps.destroy({ name: op.name });

                  break;
                }
                case 'crash': {
                  const imp = await findImpByName(ctx.db, op.name);

                  ctx.fake.alive.delete(imp?.pid ?? 0);
                  break;
                }
                case 'outdate': {
                  // firecracker changed under the snapshot: its wake boots
                  // cold. Only the version moves, as on a real upgrade; an imp
                  // with no snapshot makes this a no-op.
                  const imp = await findImpByName(ctx.db, op.name);

                  const paths = buildImpPaths(ctx.dataDir, imp?.id ?? '');
                  const meta = readSnapshotMeta(paths);

                  if (meta !== null) {
                    writeSnapshotMeta(paths, { ...meta, firecrackerVersion: 'v0.1.0' });
                  }

                  break;
                }
                case 'enforce': {
                  await ctx.governor.enforce();

                  break;
                }
                case 'sigterm': {
                  // impd stopping: every imp to sleep, and no boot after that
                  await ctx.imps.sleepAllImps();

                  break;
                }
                case 'tick': {
                  ctx.advance(40_000);
                  break;
                }
              }
            };

            // every op starts where the scheduler lets it; a rejection is kept
            // for the checks below
            const all = Promise.all(
              ops.map(async (op) => {
                await scheduler.schedule(Promise.resolve());

                return runOp(op).then(
                  () => null,
                  (error: unknown) => error,
                );
              }),
            );

            // released first, pass or fail: every call and the lifecycle work
            // they started end before the impd goes, so no late error lands
            // in the next case's router error log
            stack.defer(async () => {
              ctx.fake.setPace(() => Promise.resolve());
              ctx.fake.clearQueues();
              ctx.fake.releaseHangs();

              await scheduler.waitIdle();

              await all;

              await ctx.imps.waitForLifecycle();
            });

            // hangs are released once nothing else can move; a call still
            // pending past the deadline waits on something that never comes
            await waitFor(
              async () => {
                await scheduler.waitIdle();

                ctx.fake.releaseHangs();

                if (Bun.peek.status(all) === 'pending') {
                  throw new Error('a call never settled');
                }
              },
              { intervalMs: 0 },
            );

            const errors = await all;

            // from here on the VMs behave, so the checks below see what the
            // ops left, not new failures
            ctx.fake.setPace(() => Promise.resolve());
            ctx.fake.clearQueues();

            await ctx.imps.waitForLifecycle();

            // a call may fail only with a code the API declares for it; an
            // internal error only when the stub VMM made it
            const unknown = errors.filter(
              (error) =>
                error !== null &&
                !(
                  typeof error === 'object' &&
                  'code' in error &&
                  [
                    'NOT_FOUND',
                    'CONFLICT',
                    'INVALID_STATE',
                    'RAM_BUDGET_EXCEEDED',
                    'INTERNAL_SERVER_ERROR',
                    'SERVICE_UNAVAILABLE',
                  ].includes(String(error.code))
                ),
            );

            // the router's unexpected failures; the stub VMM makes plenty on
            // purpose
            const realErrors = ctx.rpcFailures.filter((error) => !(error instanceof StubVmError));

            const sleeps = await Promise.all(governorSleeps);

            const pinnedSleeps = sleeps.filter((sleep) => sleep.held);

            const quiescent = await findBrokenInvariants(ctx, false);

            // the list runs the liveness pass that repairs dead VMs
            await client.imps.list();

            const repaired = await findBrokenInvariants(ctx, true);
            const afterOps = await listImps(ctx.db);

            // the governor may sleep every running imp without a hold: none
            // is locked or has an open exec session or request
            const busy = afterOps.filter(
              (imp) => ctx.imps.isImpBusy(imp.id) || ctx.imps.tracker.count(imp.id) > 0,
            );

            expect(unknown).toBeEmpty();
            expect(realErrors).toBeEmpty();
            expect(pinnedSleeps).toBeEmpty();
            expect(quiescent).toBeEmpty();
            expect(repaired).toBeEmpty();
            expect(busy).toBeEmpty();

            // the last step of every sequence: a governor pass. It never
            // reaches the shortfall, which the governor property "enforce on
            // a crowded host" covers
            await ctx.governor.enforce();

            const usage = await ctx.governor.readUsage();
            const imps = await listImps(ctx.db);

            const runningUnheld = imps.filter(
              (imp) =>
                imp.state === 'running' &&
                (imp.holdUntil === null || imp.holdUntil.getTime() <= ctx.now()),
            );

            // under the budget, or no imp the governor may sleep is running
            const sleepableOverBudget =
              usage.usedMib > ctx.config.ramBudgetMib ? runningUnheld : [];

            expect(sleepableOverBudget).toBeEmpty();
          }),
      ),
      { numRuns: 300 },
    );
  },

  // the time all 300 cases may take, each with its own impd
  60_000,
);
