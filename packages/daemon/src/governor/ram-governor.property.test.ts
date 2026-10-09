import { expect, test } from 'bun:test';
import fc from 'fast-check';
import { buildStubGovernedHost } from '../test-utils/build-stub-governed-host';
import type { RoomLeft } from '../test-utils/build-stub-governed-host';
import { buildStubGovernedHostArbitraries } from '../test-utils/build-stub-governed-host-arbitraries';
import { createRamGovernor } from './ram-governor';

// Each case builds its own host and governor, which hold no resource to
// release. A failure reports fast-check's seed, path and shrunk counterexample.

test('it keeps each admission within the budget and never asks a pinned imp to sleep, one op at a time', async () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c', 'd', 'e', 'f']);

  const opArb = fc.oneof(
    arbitraries.admit,
    arbitraries.change,
    fc.constant({ kind: 'enforce' as const }),
  );

  await fc.assert(
    fc.asyncProperty(arbitraries.awake, fc.array(opArb, { maxLength: 40 }), async (awake, ops) => {
      const host = buildStubGovernedHost({
        budgetMib: 1000,
        ids: ['a', 'b', 'c', 'd', 'e', 'f'],
        awake,
      });

      const governor = createRamGovernor({ ...host.deps, log: () => {} });

      for (const op of ops) {
        const awakeBefore = [...host.imps.values()].filter((imp) => imp.awake).length;
        const callsBefore = host.sleepCalls.length;
        let rejected = false;

        if (op.kind === 'admit') {
          if (host.findImp(op.id).awake) {
            continue;
          }

          // an admit that cannot fit throws RAM_BUDGET_EXCEEDED; anything
          // else fails the property
          const outcome = await governor
            .admit({
              id: op.id,
              name: op.id,
              reserveMib: op.reserveMib,
              memoryMib: op.reserveMib + op.extraMib,
            })
            .then(() => 'admitted' as const)
            .catch((error: unknown) => {
              expect(error).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

              return 'rejected' as const;
            });

          if (outcome === 'admitted') {
            host.markAdmitted(op.id);

            const usage = await governor.readUsage();

            expect(usage.usedMib + usage.reservedMib).toBeLessThanOrEqual(1000);
          } else {
            rejected = true;

            const reservedMib = await host.readReservation(op.id, governor);

            expect(reservedMib).toBe(0);
          }
        } else if (op.kind === 'enforce') {
          await governor.enforce();

          // under the budget, or every imp it may sleep is asleep
          expect(host.findRoomLeft()).toSatisfy(
            (room: RoomLeft) => room.overMib <= 0 || room.eligibleAwake === 0,
          );
        } else {
          host.applyChange(op, governor);
        }

        const calls = host.sleepCalls.slice(callsBefore);

        // nothing changes between the pick and the sleep: no pinned imp is
        // even asked, and each awake imp at most once
        expect(calls.filter((call) => !call.eligible)).toStrictEqual([]);
        expect(calls.length).toBeLessThanOrEqual(awakeBefore);

        // a rejected admit gives up at a failed sleep, never after a sleep
        // that worked, which would leave the pick enough
        if (rejected) {
          expect(calls.at(-1)?.outcome ?? 'none').not.toBe('slept');
        }
      }
    }),
    { numRuns: 1000 },
  );
}, 30_000);

test('it gets a crowded host under the budget or sleeps every imp it may', async () => {
  // imps up to the whole budget each, often held or busy: often the imps
  // enforce may sleep cannot free enough between them
  const crowdedArb = fc.uniqueArray(
    fc.record({
      id: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
      rssMib: fc.integer({ min: 0, max: 1000 }),
      held: fc.boolean(),
      busy: fc.boolean(),
    }),
    { selector: (imp) => imp.id, minLength: 1, maxLength: 6 },
  );

  await fc.assert(
    fc.asyncProperty(crowdedArb, async (crowded) => {
      const host = buildStubGovernedHost({
        budgetMib: 1000,
        ids: ['a', 'b', 'c', 'd', 'e', 'f'],
        awake: crowded,
      });

      const governor = createRamGovernor({ ...host.deps, log: () => {} });

      for (const imp of crowded) {
        host.applyChange({ kind: 'hold', id: imp.id, on: imp.held }, governor);
        host.applyChange({ kind: 'busy', id: imp.id, on: imp.busy }, governor);
      }

      await governor.enforce();

      expect(host.sleepCalls.filter((call) => !call.eligible)).toStrictEqual([]);

      expect(host.findRoomLeft()).toSatisfy(
        (room: RoomLeft) => room.overMib <= 0 || room.eligibleAwake === 0,
      );
    }),
    { numRuns: 300 },
  );
}, 30_000);

test('it settles concurrent admits with holds and RSS changes inside them, leaving no reservation for a rejected one', async () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c', 'd', 'e', 'f']);

  // up to four admits for different imps, started at once
  const admitsArb = fc.uniqueArray(arbitraries.admit, {
    selector: (admit) => admit.id,
    maxLength: 4,
  });

  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      arbitraries.awake,
      admitsArb,
      fc.array(arbitraries.change, { maxLength: 20 }),
      async (scheduler, awake, admits, changes) => {
        const host = buildStubGovernedHost({
          budgetMib: 1000,
          ids: ['a', 'b', 'c', 'd', 'e', 'f'],
          awake,
        });

        const governor = createRamGovernor({ ...host.deps, log: () => {} });

        host.pacer.pace = () => scheduler.schedule(Promise.resolve());

        const pending = admits.filter((admit) => !host.findImp(admit.id).awake);

        const admitting = pending.map((admit) =>
          governor
            .admit({
              id: admit.id,
              name: admit.id,
              reserveMib: admit.reserveMib,
              memoryMib: admit.reserveMib + admit.extraMib,
            })
            .then(() => {
              host.markAdmitted(admit.id);

              return { id: admit.id, outcome: 'admitted' as const };
            })
            .catch((error: unknown) => {
              expect(error).toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

              return { id: admit.id, outcome: 'rejected' as const };
            }),
        );

        const enforcing = governor.enforce();

        // each change lands wherever the scheduler releases it, inside an
        // admit as often as between two
        const changing = changes.map(async (change) => {
          await scheduler.schedule(Promise.resolve());

          host.applyChange(change, governor);
        });

        const outcomes = await scheduler.waitFor(Promise.all(admitting));

        await scheduler.waitFor(Promise.all([enforcing, ...changing]));

        // a pin set after the pick reaches the stand-in, which refuses it as
        // the real sleep does under the lock; the governor moves on. Each
        // admit and the enforce pass ask each imp at most once.
        expect(host.sleepCalls.length).toBeLessThanOrEqual((admitting.length + 1) * 6);

        host.pacer.pace = () => Promise.resolve();

        for (const admitted of outcomes) {
          if (admitted.outcome === 'rejected') {
            const reservedMib = await host.readReservation(admitted.id, governor);

            expect(reservedMib).toBe(0);
          }
        }

        await governor.enforce();

        // under the budget, or every imp it may sleep is asleep
        expect(host.findRoomLeft()).toSatisfy(
          (room: RoomLeft) => room.overMib <= 0 || room.eligibleAwake === 0,
        );
      },
    ),
    { numRuns: 200 },
  );
}, 30_000);

test('it keeps a grow within the budget, never sleeps its grower, and sleeps only for room it then has', async () => {
  const arbitraries = buildStubGovernedHostArbitraries(['a', 'b', 'c', 'd', 'e', 'f']);

  const opArb = fc.oneof(
    fc.record({
      kind: fc.constant('grow' as const),
      id: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
      mib: fc.integer({ min: 2, max: 600 }),
    }),
    arbitraries.change,
    fc.constant({ kind: 'enforce' as const }),
  );

  await fc.assert(
    fc.asyncProperty(arbitraries.awake, fc.array(opArb, { maxLength: 40 }), async (awake, ops) => {
      const host = buildStubGovernedHost({
        budgetMib: 1000,
        ids: ['a', 'b', 'c', 'd', 'e', 'f'],
        awake,
      });

      const governor = createRamGovernor({ ...host.deps, log: () => {} });

      for (const op of ops) {
        if (op.kind === 'enforce') {
          await governor.enforce();

          continue;
        }

        if (op.kind !== 'grow') {
          host.applyChange(op, governor);
          continue;
        }

        if (!host.findImp(op.id).awake) {
          continue;
        }

        const callsBefore = host.sleepCalls.length;

        const admitted = await governor.admitGrow({ id: op.id, name: op.id, mib: op.mib });

        const calls = host.sleepCalls.slice(callsBefore);

        expect(calls.map((call) => call.id)).not.toContain(op.id);
        expect(calls.filter((call) => !call.eligible)).toStrictEqual([]);

        if (admitted) {
          const usage = await governor.readUsage();

          expect(usage.usedMib + usage.reservedMib).toBeLessThanOrEqual(1000);

          // the guest's RSS shows the grow once the plug lands
          host.findImp(op.id).rssMib += op.mib;
        } else {
          // refused: nothing slept for room that was not there
          expect(calls.at(-1)?.outcome ?? 'none').not.toBe('slept');
        }
      }
    }),
    { numRuns: 500 },
  );
}, 30_000);
