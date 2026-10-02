import { expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import fc from 'fast-check';
import { findImpByName, listImps } from '../db/imps';
import { buildImpPaths } from '../storage/data-layout';
import type { VmOutcome, VmStep } from './fake-vmm';
import { buildTestApp, findBrokenInvariants, setupImpTest, writeTestSnapshot } from './test-imps';

const NAMES = ['a', 'b', 'c', 'd'] as const;

// 300 MiB per awake fake VM, 410 reserved per boot or wake: with two imps
// awake a third makes the governor sleep one, and holds leave it none
const ENV = {
  IMP_RAM_BUDGET_MIB: '900',
  IMP_DEFAULT_MEMORY_MIB: '512',
  IMP_BOOT_RESERVE_PERCENT: '80',
  IMP_WAKE_RESERVE_MIB: '410',
};

// what a call may fail with; a fake VM failure is an internal error
const KNOWN_CODES = new Set([
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_STATE',
  'RAM_BUDGET_EXCEEDED',
  'INTERNAL_SERVER_ERROR',
  'SERVICE_UNAVAILABLE',
]);

// hangs are released once nothing else can move; more rounds than that means
// a call waits on something that never comes
const MAX_SETTLE_ROUNDS = 50;

type LifecycleOp =
  | {
      readonly kind:
        | 'create'
        | 'sleep'
        | 'wake'
        | 'start'
        | 'stop'
        | 'restore'
        | 'hold'
        | 'destroy'
        | 'crash'
        | 'outdate';
      readonly name: string;
    }
  | { readonly kind: 'enforce' | 'tick' | 'sigterm' };

const nameArb = fc.constantFrom(...NAMES);

// holds come often: only with imps pinned does the budget turn calls away
const opArb: fc.Arbitrary<LifecycleOp> = fc.oneof(
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

const STEPS: readonly VmStep[] = ['boot', 'wake', 'sleep', 'stop', 'agentReady'];

// the outcomes each step's next calls take, in order
const scriptArb = fc.tuple(...STEPS.map(() => fc.array(outcomeArb, { maxLength: 4 })));

test('concurrent lifecycle calls on a few imps leave consistent records', async () => {
  // the router logs every internal error; the fake makes plenty on purpose
  const quiet = spyOn(console, 'error').mockImplementation(() => {});

  try {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(opArb, { minLength: 4, maxLength: 16 }),
        scriptArb,
        async (scheduler, ops, script) => {
          await using ctx = await setupImpTest({ env: ENV });

          await ctx.createTestImage('ubuntu');

          const client = buildTestApp(ctx, ctx).client;

          // c asleep, a and b awake, d not created yet
          for (const name of ['c', 'a', 'b']) {
            await client.imps.create({ name });
            await client.checkpoints.create({ name, label: 'base' });

            if (name === 'c') {
              await client.imps.sleep({ name });
            }
          }

          for (const [index, step] of STEPS.entries()) {
            ctx.fake.queue(step, ...(script[index] ?? []));
          }

          ctx.fake.setPace(() => scheduler.schedule(Promise.resolve()));

          const runOp = async (op: LifecycleOp): Promise<void> => {
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
                // a snapshot from another firecracker: its wake boots cold
                const imp = await findImpByName(ctx.db, op.name);

                const paths = buildImpPaths(ctx.dataDir, imp?.id ?? '');

                if (existsSync(paths.snapshotMeta)) {
                  writeTestSnapshot(paths, Date.now(), 'v0.1.0');
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
          const calls = ops.map(async (op) => {
            await scheduler.schedule(Promise.resolve());

            try {
              await runOp(op);

              return null;
            } catch (error) {
              return error;
            }
          });

          const settled = { done: false };

          const all = Promise.all(calls).then((errors) => {
            settled.done = true;

            return errors;
          });

          for (let round = 0; !settled.done; round += 1) {
            if (round === MAX_SETTLE_ROUNDS) {
              throw new Error('a call never settled');
            }

            await scheduler.waitIdle();

            ctx.fake.releaseHangs();

            await Bun.sleep(0);
          }

          const errors = await all;

          // from here on the VMs behave, so the checks below see what the
          // ops left, not new failures
          ctx.fake.setPace(() => Promise.resolve());
          ctx.fake.clearQueues();

          await ctx.imps.waitForLifecycle();

          const unknown = errors.filter(
            (error) =>
              error !== null &&
              !(
                typeof error === 'object' &&
                'code' in error &&
                KNOWN_CODES.has(String(error.code))
              ),
          );

          const quiescent = await findBrokenInvariants(ctx, false);

          // the list runs the liveness pass that repairs dead VMs
          await client.imps.list();

          const repaired = await findBrokenInvariants(ctx, true);

          expect(unknown).toEqual([]);
          expect(quiescent).toEqual([]);
          expect(repaired).toEqual([]);

          // the governor brings measured usage under the budget whenever the
          // imps it may sleep are enough
          await ctx.governor.enforce();

          const usage = await ctx.governor.readUsage();
          const imps = await listImps(ctx.db);

          const freeableMib =
            imps.filter(
              (imp) =>
                imp.state === 'running' &&
                (imp.holdUntil === null || imp.holdUntil.getTime() <= ctx.now()),
            ).length * 300;

          const overMib = usage.usedMib - ctx.config.ramBudgetMib;

          expect(overMib <= 0 || freeableMib < overMib).toBeTrue();
        },
      ),
      { numRuns: 300 },
    );
  } finally {
    quiet.mockRestore();
  }
});
