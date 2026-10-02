import { expect, test } from 'bun:test';
import fc from 'fast-check';
import { createKeyedMutex } from '../imps/keyed-mutex';
import { createLockFreeSleep } from '../imps/lock-free-sleep';
import type { SleepOutcome } from '../imps/lock-free-sleep';
import { createRamGovernor } from './ram-governor';

// hundreds of runs: a loaded host can stretch them past the 5 s default
const SLOW_TEST_TIMEOUT_MS = 30_000;
const BUDGET_MIB = 1000;
const IMP_IDS: readonly string[] = ['a', 'b', 'c', 'd', 'e', 'f'];

// far past any clock the ops reach: a hold that never expires on its own
const HELD_FOREVER = Number.MAX_SAFE_INTEGER;

interface ModelImp {
  awake: boolean;
  rssMib: number;
  lastActiveAt: number;
  held: boolean;
  busy: boolean;
}

interface AdmitOp {
  readonly kind: 'admit';
  readonly id: string;
  readonly reserveMib: number;
  readonly extraMib: number;
}

type MutationOp =
  | { readonly kind: 'rss'; readonly id: string; readonly mib: number }
  | { readonly kind: 'hold'; readonly id: string; readonly on: boolean }
  | { readonly kind: 'busy'; readonly id: string; readonly on: boolean }
  | { readonly kind: 'touch'; readonly id: string }
  | { readonly kind: 'stop'; readonly id: string }
  | { readonly kind: 'tick'; readonly ms: number };

type GovernorOp = AdmitOp | MutationOp | { readonly kind: 'enforce' };

const idArb = fc.constantFrom(...IMP_IDS);

const admitArb: fc.Arbitrary<AdmitOp> = fc.record({
  kind: fc.constant('admit' as const),
  id: idArb,
  reserveMib: fc.integer({ min: 50, max: 700 }),
  extraMib: fc.integer({ min: 0, max: 600 }),
});

const mutationArb: fc.Arbitrary<MutationOp> = fc.oneof(
  fc.record({
    kind: fc.constant('rss' as const),
    id: idArb,
    mib: fc.integer({ min: 0, max: 600 }),
  }),
  fc.record({ kind: fc.constant('hold' as const), id: idArb, on: fc.boolean() }),
  fc.record({ kind: fc.constant('busy' as const), id: idArb, on: fc.boolean() }),
  fc.record({ kind: fc.constant('touch' as const), id: idArb }),
  fc.record({ kind: fc.constant('stop' as const), id: idArb }),
  fc.record({ kind: fc.constant('tick' as const), ms: fc.integer({ min: 0, max: 25_000 }) }),
);

const opArb: fc.Arbitrary<GovernorOp> = fc.oneof(
  admitArb,
  mutationArb,
  fc.constant({ kind: 'enforce' as const }),
);

// up to four admits for different imps, started at once
const concurrentAdmitsArb = fc.uniqueArray(admitArb, {
  selector: (admit) => admit.id,
  maxLength: 4,
});

// imps that start awake, with what they measure
const startArb = fc.uniqueArray(
  fc.record({ id: idArb, rssMib: fc.integer({ min: 0, max: 400 }) }),
  { selector: (imp) => imp.id, maxLength: IMP_IDS.length },
);

// A model host for the governor. `pace` runs before each of its reads and
// sleeps. The fake sleep refuses a held or busy imp at call time, as the real
// one does under the imp's lock.
function setupModel(start: readonly { readonly id: string; readonly rssMib: number }[]) {
  const imps = new Map<string, ModelImp>(
    IMP_IDS.map((id) => [
      id,
      { awake: false, rssMib: 0, lastActiveAt: 0, held: false, busy: false },
    ]),
  );

  for (const [index, imp] of start.entries()) {
    imps.set(imp.id, {
      awake: true,
      rssMib: imp.rssMib,
      lastActiveAt: index,
      held: false,
      busy: false,
    });
  }

  const clock = { now: 1_000_000 };
  const pacer: { pace: () => Promise<void> } = { pace: () => Promise.resolve() };

  // every sleep the governor asked for, with the imp's state at that moment
  const sleepCalls: { readonly id: string; readonly eligible: boolean }[] = [];
  const mutex = createKeyedMutex();

  const findImp = (id: string): ModelImp => {
    const imp = imps.get(id);

    if (imp === undefined) {
      throw new Error(`no imp ${id}`);
    }

    return imp;
  };

  const trySleepImp = createLockFreeSleep<string>(
    (id, action) => mutex.tryRunExclusive(id, () => action(id)),
    async (id): Promise<SleepOutcome> => {
      await pacer.pace();

      const imp = findImp(id);
      const eligible = imp.awake && !imp.held && !imp.busy;

      sleepCalls.push({ id, eligible });

      if (!eligible) {
        return 'skipped';
      }

      imp.awake = false;

      return 'slept';
    },
  );

  const governor = createRamGovernor({
    budgetMib: BUDGET_MIB,
    listAwake: async () => {
      await pacer.pace();

      return [...imps].flatMap(([id, imp]) =>
        imp.awake
          ? [
              {
                id,
                name: id,
                pid: IMP_IDS.indexOf(id) + 1,
                apiSocket: id,
                lastActiveAt: imp.lastActiveAt,
                holdUntil: imp.held ? HELD_FOREVER : null,
              },
            ]
          : [],
      );
    },

    // apiSocket carries the id
    readRamMib: (_pid, id) => (imps.get(id)?.awake === true ? findImp(id).rssMib : null),
    isBusy: (id) => findImp(id).busy,
    trySleepImp,
    log: () => {
      // quiet
    },
    now: () => clock.now,
  });

  // What the id holds reserved. Asleep, its reservation counts in full;
  // awake with a huge measurement, it counts nothing, since an awake imp
  // counts the larger of the two. The difference is the reservation.
  const readReservation = async (id: string): Promise<number> => {
    const imp = findImp(id);

    if (imp.awake) {
      return 0;
    }

    const asleep = await governor.readUsage();

    imp.awake = true;
    imp.rssMib = 1_000_000;

    const measured = await governor.readUsage();

    imp.awake = false;
    imp.rssMib = 0;

    return asleep.reservedMib - measured.reservedMib;
  };

  // measured usage over the budget, and how many imps the governor may still
  // sleep
  const findRoomLeft = (): { readonly overMib: number; readonly eligibleAwake: number } => {
    const awake = [...imps.values()].filter((imp) => imp.awake);
    const usedMib = awake.reduce((sum, imp) => sum + imp.rssMib, 0);
    const eligibleAwake = awake.filter((imp) => !imp.held && !imp.busy).length;

    return { overMib: usedMib - BUDGET_MIB, eligibleAwake };
  };

  const applyMutation = (op: MutationOp): void => {
    switch (op.kind) {
      case 'rss': {
        findImp(op.id).rssMib = op.mib;
        break;
      }
      case 'hold': {
        findImp(op.id).held = op.on;
        break;
      }
      case 'busy': {
        findImp(op.id).busy = op.on;
        break;
      }
      case 'touch': {
        findImp(op.id).lastActiveAt = clock.now;
        break;
      }
      case 'stop': {
        findImp(op.id).awake = false;

        governor.release(op.id);
        break;
      }
      case 'tick': {
        clock.now += op.ms;
        break;
      }
    }
  };

  // admits a sleeping imp; once admitted it is awake and measures nothing yet
  const runAdmit = async (op: AdmitOp): Promise<'admitted' | 'rejected'> => {
    try {
      await governor.admit({
        id: op.id,
        name: op.id,
        reserveMib: op.reserveMib,
        memoryMib: op.reserveMib + op.extraMib,
      });
    } catch (error) {
      expect(error).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

      return 'rejected';
    }

    const imp = findImp(op.id);

    imp.awake = true;
    imp.rssMib = 0;
    imp.lastActiveAt = clock.now;

    return 'admitted';
  };

  return {
    imps,
    pacer,
    sleepCalls,
    governor,
    findImp,
    readReservation,
    findRoomLeft,
    applyMutation,
    runAdmit,
  };
}

test(
  'one op at a time: admission keeps the budget and never picks a pinned imp',
  async () => {
    await fc.assert(
      fc.asyncProperty(startArb, fc.array(opArb, { maxLength: 40 }), async (start, ops) => {
        const model = setupModel(start);

        for (const op of ops) {
          const awakeBefore = [...model.imps.values()].filter((imp) => imp.awake).length;
          const callsBefore = model.sleepCalls.length;

          if (op.kind === 'admit') {
            if (model.findImp(op.id).awake) {
              continue;
            }

            const outcome = await model.runAdmit(op);

            if (outcome === 'admitted') {
              const usage = await model.governor.readUsage();

              expect(usage.usedMib + usage.reservedMib).toBeLessThanOrEqual(BUDGET_MIB);
            } else {
              const reservedMib = await model.readReservation(op.id);

              expect(reservedMib).toBe(0);
            }
          } else if (op.kind === 'enforce') {
            await model.governor.enforce();

            // under the budget, or every imp it may sleep is asleep
            const room = model.findRoomLeft();

            expect(room.overMib <= 0 || room.eligibleAwake === 0).toBeTrue();
          } else {
            model.applyMutation(op);
          }

          const calls = model.sleepCalls.slice(callsBefore);

          // nothing changes between the pick and the sleep: no pinned imp is
          // even asked, and each awake imp at most once
          expect(calls.filter((call) => !call.eligible)).toEqual([]);
          expect(calls.length).toBeLessThanOrEqual(awakeBefore);
        }
      }),
      { numRuns: 300 },
    );
  },
  SLOW_TEST_TIMEOUT_MS,
);

// A host where imps up to the whole budget may be held or busy: often the
// imps enforce may sleep cannot free enough between them.
const crowdedHostArb = fc.uniqueArray(
  fc.record({
    id: idArb,
    rssMib: fc.integer({ min: 0, max: BUDGET_MIB }),
    held: fc.boolean(),
    busy: fc.boolean(),
  }),
  { selector: (imp) => imp.id, minLength: 1, maxLength: IMP_IDS.length },
);

test(
  'enforce on a crowded host gets under the budget or sleeps every imp it may',
  async () => {
    await fc.assert(
      fc.asyncProperty(crowdedHostArb, async (host) => {
        const model = setupModel(host);

        for (const imp of host) {
          Object.assign(model.findImp(imp.id), { held: imp.held, busy: imp.busy });
        }

        await model.governor.enforce();

        const room = model.findRoomLeft();

        expect(model.sleepCalls.filter((call) => !call.eligible)).toEqual([]);
        expect(room.overMib <= 0 || room.eligibleAwake === 0).toBeTrue();
      }),
      { numRuns: 300 },
    );
  },
  SLOW_TEST_TIMEOUT_MS,
);

test(
  'concurrent admits with holds and RSS changes inside them all settle',
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        startArb,
        concurrentAdmitsArb,
        fc.array(mutationArb, { maxLength: 20 }),
        async (scheduler, start, admits, mutations) => {
          const model = setupModel(start);

          model.pacer.pace = () => scheduler.schedule(Promise.resolve());

          const pending = admits.filter((admit) => !model.findImp(admit.id).awake);
          const admitting = pending.map((admit) => model.runAdmit(admit));
          const enforcing = model.governor.enforce();

          // each mutation lands wherever the scheduler releases it, inside an
          // admit as often as between two
          const mutating = mutations.map(async (op) => {
            await scheduler.schedule(Promise.resolve());

            model.applyMutation(op);
          });

          const outcomes = await scheduler.waitFor(Promise.all(admitting));

          await scheduler.waitFor(Promise.all([enforcing, ...mutating]));

          // a pin set after the pick reaches the fake, which refuses it as the
          // real sleep does under the lock; the governor moves on. Each admit
          // and the enforce pass ask each imp at most once.
          expect(model.sleepCalls.length).toBeLessThanOrEqual(
            (admitting.length + 1) * IMP_IDS.length,
          );

          model.pacer.pace = () => Promise.resolve();

          for (const [index, outcome] of outcomes.entries()) {
            const id = pending[index]?.id ?? '';

            if (outcome === 'rejected' && !model.findImp(id).awake) {
              const reservedMib = await model.readReservation(id);

              expect(reservedMib).toBe(0);
            }
          }

          await model.governor.enforce();

          // as above
          const room = model.findRoomLeft();

          expect(room.overMib <= 0 || room.eligibleAwake === 0).toBeTrue();
        },
      ),
      { numRuns: 200 },
    );
  },
  SLOW_TEST_TIMEOUT_MS,
);
