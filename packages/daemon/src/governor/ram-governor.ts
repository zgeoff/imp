import { EVENT_VERSION } from '@imp/api';
import { buildImpOverBudgetError, buildRamBudgetError } from '../api-errors';
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
  readonly name: string;
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
}

interface RoomOutcome {
  readonly fits: boolean;
  readonly slept: number;

  // a victim's snapshot did not fit on the disk
  readonly diskFull: boolean;

  // what was still missing at the last measurement, and what was in use
  readonly missingMib: number;
  readonly effectiveMib: number;
}

interface RamUsage {
  // measured: what awake Firecrackers own now
  readonly usedMib: number;

  // reservations for boots and wakes the measurement does not show yet
  readonly reservedMib: number;
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

    return { awake, byImp, usedMib, effectiveMib };
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
        return { fits: true, slept, diskFull, missingMib, effectiveMib: usage.effectiveMib };
      }

      const time = now();

      const candidates = usage.awake.map((imp) => ({
        id: imp.id,
        ramMib: usage.byImp.get(imp.id) ?? 0,
        lastActiveAt: imp.lastActiveAt,
        held: imp.holdUntil !== null && imp.holdUntil > time,
        busy: deps.isBusy(imp.id) || passed.has(imp.id),
      }));

      const picked = pickSleepVictims(candidates, missingMib);

      // one victim per pass: after a skip or a failure the rest of the pick is
      // stale, and sleeping it could cost imps their memory for an admission
      // that then gives up
      const [id] = picked.victims;

      if (id === undefined || (!picked.enough && whenShort === 'giveUp')) {
        return { fits: false, slept, diskFull, missingMib, effectiveMib: usage.effectiveMib };
      }

      const outcome = await deps.trySleepImp(id, reason, { by: 'governor' });

      if (outcome === 'slept') {
        reservations.delete(id);

        slept += 1;

        emitDecision({
          decision: 'slept',
          name: usage.awake.find((imp) => imp.id === id)?.name ?? id,
          trigger: reason,
          usedMib: usage.effectiveMib,
        });
      } else {
        passed.add(id);

        diskFull ||= outcome === 'diskFull';
      }
    }
  };

  return {
    admit: (request) =>
      admission.run(async () => {
        if (request.memoryMib > deps.budgetMib) {
          const usage = await readEffectiveUsage(request.id);

          emitDecision({
            decision: 'refused',
            name: request.name,
            trigger: 'admission',
            usedMib: usage.effectiveMib,
            reserveMib: request.reserveMib,
          });

          throw buildImpOverBudgetError(deps.budgetMib, usage.effectiveMib, request.memoryMib);
        }

        const findMissing = (usage: UsageTotals) =>
          usage.effectiveMib + request.reserveMib - deps.budgetMib;

        const room =
          request.maySleepImps === false
            ? await readFreeRoom(request.id, findMissing)
            : await makeRoom(request.id, `to make room for ${request.name}`, 'giveUp', findMissing);

        const diskFull = room.diskFull ? (deps.readDiskFullError?.() ?? null) : null;

        // the disk, not the budget, kept an idle imp awake
        if (!room.fits && diskFull !== null) {
          throw diskFull;
        }

        if (!room.fits) {
          const usage = await readEffectiveUsage(request.id);

          emitDecision({
            decision: 'refused',
            name: request.name,
            trigger: 'admission',
            usedMib: usage.effectiveMib,
            reserveMib: request.reserveMib,
          });

          throw buildRamBudgetError(deps.budgetMib, usage.effectiveMib, request.reserveMib);
        }

        reservations.set(request.id, {
          mib: request.reserveMib,
          until: now() + RESERVATION_TTL_MS,
        });

        emitDecision({
          decision: 'admitted',
          name: request.name,
          trigger: 'admission',
          usedMib: room.effectiveMib,
          reserveMib: request.reserveMib,
        });
      }),

    release: (id) => {
      reservations.delete(id);
    },

    readUsage: async () => {
      const usage = await readEffectiveUsage(null);

      return {
        usedMib: usage.usedMib,
        reservedMib: usage.effectiveMib - usage.usedMib,
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
