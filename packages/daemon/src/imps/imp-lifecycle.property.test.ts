import { expect, onTestFinished, spyOn, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import fc from 'fast-check';
import { findImpByName, listImps } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { readSnapshotMeta, writeSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import { StubVmError } from '../test-utils/build-stub-vmm';
import type { VmOutcome } from '../test-utils/build-stub-vmm';
import { runWithStack } from '../test-utils/run-with-stack';
import { buildTestApp, createImpTest, findBrokenInvariants } from './test-imps';

test(
  'it leaves consistent records after concurrent lifecycle calls on a few imps',
  async () => {
    // the router logs every internal error, and the stub VMM makes plenty on
    // purpose; the checks below read what it logged
    const routerErrors = spyOn(console, 'error').mockImplementation(() => {});

    onTestFinished(() => {
      routerErrors.mockRestore();
    });

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
            routerErrors.mockClear();

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

            const realErrors = routerErrors.mock.calls
              .map((call): unknown => call[1])
              .filter((error) => !(error instanceof StubVmError));

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
