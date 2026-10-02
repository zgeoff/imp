import { EVENT_VERSION } from '@imp/api';
import { buildImpOverBudgetError, buildRamBudgetError, readNeededMib } from '../api-errors';
import type { ProtectedImp } from '../api-errors';
import type { EventBus } from '../events/event-bus';
import type { LockFreeSleep } from '../imps/lock-free-sleep';
import { createSemaphore } from '../imps/semaphore';
import { pickSleepVictims } from './pick-sleep-victims';

// A reservation covers a VM until its RSS catches up: a VM that just booted
// or woke measures small for some seconds.
const RESERVATION_TTL_MS = 20_000;

interface AwakeImp {
  readonly id: string;
  readonly name: string;
  readonly pid: number;
  readonly apiSocket: string;
  readonly lastActiveAt: number;
  readonly holdUntil: number | null;
}

interface AdmissionRequest {
  readonly id: string;

  // the imp's name; null for work that is no imp's, such as a boot
  // template's build, which has no GovernorDecision event
  readonly name: string | null;
  readonly reserveMib: number;

  // the imp's configured memory: a guest that can grow past the whole budget
  // is never admitted
  readonly memoryMib: number;

  // false: admitted only into free room, never by sleeping an imp; for work
  // no user waits on, such as a boot template's build
  readonly maySleepImps?: boolean;
}

interface UsageTotals {
  readonly usedMib: number;
  readonly effectiveMib: number;
}

// When the imps makeRoom may sleep cannot free enough: admission sleeps none
// for a request that cannot fit; enforcement sleeps them all, since the
// budget protects the host
type WhenShort = 'giveUp' | 'sleepAll';

// a GovernorDecision event, less what every one shares
interface GovernorDecision {
  readonly decision: 'admitted' | 'refused' | 'slept';
  readonly name: string;
  readonly trigger: string;
  readonly usedMib: number;
  readonly reserveMib?: number;
  readonly neededMib?: number;
  readonly protectedCount?: number;
}

interface RoomOutcome {
  readonly fits: boolean;
  readonly slept: number;

  // a victim's snapshot did not fit on the disk
  readonly diskFull: boolean;

  // what was still missing at the last measurement, and what was in use
  readonly missingMib: number;
  readonly effectiveMib: number;

  // the awake imps it could not sleep, at the last pass
  readonly protected: readonly ProtectedImp[];
}

interface RamUsage {
  // measured: what awake Firecrackers own now
  readonly usedMib: number;

  // reservations for boots and wakes the measurement does not show yet
  readonly reservedMib: number;

  // kept free for merged pages that writes split again (IMP_KSM)
  readonly headroomMib: number;
}

// The part of the governor the imp lifecycle calls.
export interface RamAdmission {
  // makes room for the imp (sleeps LRU imps) and reserves its RAM; throws
  // RAM_BUDGET_EXCEEDED when it cannot fit
  readonly admit: (request: AdmissionRequest) => Promise<void>;

  // the imp went to sleep, stopped or failed to boot
  readonly release: (id: string) => void;
}

export interface RamGovernor extends RamAdmission {
  readonly readUsage: () => Promise<RamUsage>;

  // sleeps LRU imps while measured usage is over the budget; when the imps it
  // may sleep cannot free enough, it sleeps all of them to get as close as it
  // can
  readonly enforce: () => Promise<void>;
}

export interface RamGovernorDeps {
  readonly budgetMib: number;
  readonly listAwake: () => Promise<AwakeImp[]>;
  readonly readRamMib: (pid: number, apiSocket: string) => number | null;

  // RAM to keep free besides the budget's use: with IMP_KSM, a share of what
  // KSM saves, since a guest's writes split merged pages faster than a tick
  readonly readHeadroomMib?: () => number;

  // true while the imp's lifecycle lock is taken or it has open exec sessions
  // or proxied requests: never a victim
  readonly isBusy: (id: string) => boolean;

  // sleeps the imp if it still runs and is not held; the type admits only a
  // sleep that never waits for the imp's lock, since admission is held
  readonly trySleepImp: LockFreeSleep;

  // the DISK_FULL that last turned a victim's sleep away
  readonly readDiskFullError?: () => Error | null;
  readonly log: (message: string) => void;
  readonly now?: () => number;

  // where its decisions go as GovernorDecision events
  readonly events?: EventBus;
}

export function createRamGovernor(deps: RamGovernorDeps): RamGovernor {
  // one admission or enforcement at a time
  const admission = createSemaphore(1);

  const reservations = new Map<string, { readonly mib: number; readonly until: number }>();

  const now = deps.now ?? Date.now;

  // enforce logs that it cannot reach the budget once, not every tick
  let stuckOver = false;

  const emitDecision = (decision: GovernorDecision): void => {
    deps.events?.publish({
      v: EVENT_VERSION,
      at: new Date(now()),
      ev: 'GovernorDecision',
      budgetMib: deps.budgetMib,
      ...decision,
    });
  };

  const emitAdmission = (
    request: AdmissionRequest,
    decision: 'admitted' | 'refused',
    usedMib: number,
    refusal?: Pick<GovernorDecision, 'neededMib' | 'protectedCount'>,
  ): void => {
    if (request.name !== null) {
      emitDecision({
        decision,
        name: request.name,
        trigger: 'admission',
        usedMib,
        reserveMib: request.reserveMib,
        ...refusal,
      });
    }
  };

  const readReservation = (id: string): number => {
    const reservation = reservations.get(id);

    if (reservation === undefined) {
      return 0;
    }

    if (reservation.until < now()) {
      reservations.delete(id);

      return 0;
    }

    return reservation.mib;
  };

  // the RAM each imp counts for: measured, or its reservation while larger
  const readEffectiveUsage = async (excludeId: string | null) => {
    const listed = await deps.listAwake();

    const awake = listed.filter((imp) => imp.id !== excludeId);

    const byImp = new Map<string, number>();

    let usedMib = 0;
    let effectiveMib = 0;

    for (const imp of awake) {
      const measured = deps.readRamMib(imp.pid, imp.apiSocket) ?? 0;
      const effective = Math.max(measured, readReservation(imp.id));

      byImp.set(imp.id, effective);

      usedMib += measured;
      effectiveMib += effective;
    }

    // imps that are booting or waking: reserved, not awake yet
    for (const id of reservations.keys()) {
      if (id !== excludeId && !byImp.has(id)) {
        effectiveMib += readReservation(id);
      }
    }

    const headroomMib = deps.readHeadroomMib?.() ?? 0;

    effectiveMib += headroomMib;

    return { awake, byImp, usedMib, effectiveMib, headroomMib };
  };

  // what fits without sleeping anything
  const readFreeRoom = async (
    excludeId: string,
    findMissing: (usage: UsageTotals) => number,
  ): Promise<RoomOutcome> => {
    const usage = await readEffectiveUsage(excludeId);

    const missingMib = findMissing(usage);

    return {
      fits: missingMib <= 0,
      slept: 0,
      diskFull: false,
      missingMib,
      effectiveMib: usage.effectiveMib,
      protected: [],
    };
  };

  // sleeps LRU imps until `findMissing` reports nothing missing; it gives up
  // when no eligible imp is left awake, or as `whenShort` says. Each pass
  // sleeps an imp or passes one for good, so it ends within 2n passes.
  const makeRoom = async (
    excludeId: string | null,
    reason: string,
    whenShort: WhenShort,
    findMissing: (usage: UsageTotals) => number,
  ): Promise<RoomOutcome> => {
    const passed = new Set<string>();

    let slept = 0;
    let diskFull = false;

    for (;;) {
      const usage = await readEffectiveUsage(excludeId);

      const missingMib = findMissing(usage);

      if (missingMib <= 0) {
        return {
          fits: true,
          slept,
          diskFull,
          missingMib,
          effectiveMib: usage.effectiveMib,
          protected: [],
        };
      }

      const time = now();

      // each with its name, for the decision event when it sleeps
      const candidates = usage.awake.map((imp) => ({
        id: imp.id,
        name: imp.name,
        ramMib: usage.byImp.get(imp.id) ?? 0,
        lastActiveAt: imp.lastActiveAt,
        held: imp.holdUntil !== null && imp.holdUntil > time,
        busy: deps.isBusy(imp.id) || passed.has(imp.id),
      }));

      const picked = pickSleepVictims(candidates, missingMib);

      // one victim per pass: after a skip or a failure the rest of the pick is
      // stale, and sleeping it could cost imps their memory for an admission
      // that then gives up
      const [victim] = picked.victims;

      if (victim === undefined || (!picked.enough && whenShort === 'giveUp')) {
        return {
          fits: false,
          slept,
          diskFull,
          missingMib,
          effectiveMib: usage.effectiveMib,
          protected: candidates
            .filter((candidate) => candidate.held || candidate.busy)
            .map((candidate) => ({
              name: candidate.name,
              ramMib: candidate.ramMib,
              leased: candidate.held,
              busy: candidate.busy,
            })),
        };
      }

      const outcome = await deps.trySleepImp(victim.id, reason, { by: 'governor' });

      if (outcome === 'slept') {
        reservations.delete(victim.id);

        slept += 1;

        emitDecision({
          decision: 'slept',
          name: victim.name,
          trigger: reason,
          usedMib: usage.effectiveMib,
        });
      } else {
        passed.add(victim.id);

        diskFull ||= outcome === 'diskFull';
      }
    }
  };

  return {
    admit: (request) =>
      admission.run(async () => {
        if (request.memoryMib > deps.budgetMib) {
          const usage = await readEffectiveUsage(request.id);

          emitAdmission(request, 'refused', usage.effectiveMib, {
            neededMib: readNeededMib(usage.effectiveMib, request.memoryMib, deps.budgetMib),
            protectedCount: 0,
          });

          throw buildImpOverBudgetError(deps.budgetMib, usage.effectiveMib, request.memoryMib);
        }

        const findMissing = (usage: UsageTotals) =>
          usage.effectiveMib + request.reserveMib - deps.budgetMib;

        const room =
          request.maySleepImps === false
            ? await readFreeRoom(request.id, findMissing)
            : await makeRoom(
                request.id,
                `to make room for ${request.name ?? request.id}`,
                'giveUp',
                findMissing,
              );

        const diskFull = room.diskFull ? (deps.readDiskFullError?.() ?? null) : null;

        // the disk, not the budget, kept an idle imp awake
        if (!room.fits && diskFull !== null) {
          throw diskFull;
        }

        if (!room.fits) {
          const usage = await readEffectiveUsage(request.id);

          emitAdmission(request, 'refused', usage.effectiveMib, {
            neededMib: readNeededMib(usage.effectiveMib, request.reserveMib, deps.budgetMib),
            protectedCount: room.protected.length,
          });

          throw buildRamBudgetError({
            budgetMib: deps.budgetMib,
            usedMib: usage.effectiveMib,
            requestedMib: request.reserveMib,
            protected: room.protected,
          });
        }

        reservations.set(request.id, {
          mib: request.reserveMib,
          until: now() + RESERVATION_TTL_MS,
        });

        emitAdmission(request, 'admitted', room.effectiveMib);
      }),

    release: (id) => {
      reservations.delete(id);
    },

    readUsage: async () => {
      const usage = await readEffectiveUsage(null);

      return {
        usedMib: usage.usedMib,
        reservedMib: usage.effectiveMib - usage.usedMib - usage.headroomMib,
        headroomMib: usage.headroomMib,
      };
    },

    enforce: () =>
      admission.run(async () => {
        const room = await makeRoom(
          null,
          'RAM over budget',
          'sleepAll',
          (usage) => usage.usedMib - deps.budgetMib,
        );

        const over = `over budget by ${String(room.missingMib)} MiB`;

        if (room.fits) {
          stuckOver = false;
        } else if (room.slept > 0) {
          deps.log(`impd: governor: slept ${String(room.slept)}, RAM still ${over}`);

          stuckOver = true;
        } else if (!stuckOver) {
          deps.log(`impd: governor: RAM ${over} and no idle imp left to sleep`);

          stuckOver = true;
        }
      }),
  };
}
