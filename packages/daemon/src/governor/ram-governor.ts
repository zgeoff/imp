import { buildRamBudgetError } from '../api-errors';
import { createKeyedMutex } from '../imps/keyed-mutex';
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
}

interface UsageTotals {
  readonly usedMib: number;
  readonly effectiveMib: number;
}

interface RamUsage {
  // measured: what awake Firecrackers own now
  readonly usedMib: number;

  // reservations for boots and wakes the measurement does not show yet
  readonly reservedMib: number;
  readonly byImp: ReadonlyMap<string, number>;
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

  // sleeps LRU imps while measured usage is over the budget
  readonly enforce: () => Promise<void>;
}

export interface RamGovernorDeps {
  readonly budgetMib: number;
  readonly listAwake: () => Promise<AwakeImp[]>;
  readonly readRamMib: (pid: number, apiSocket: string) => number | null;

  // true while the imp's lifecycle lock is taken or it has open exec sessions
  // or proxied requests: never a victim
  readonly isBusy: (id: string) => boolean;

  // sleeps the imp if it is still running; false when it could not
  readonly sleepImp: (id: string, reason: string) => Promise<boolean>;
  readonly log: (message: string) => void;
  readonly now?: () => number;
}

export function createRamGovernor(deps: RamGovernorDeps): RamGovernor {
  const lock = createKeyedMutex();

  const reservations = new Map<string, { readonly mib: number; readonly until: number }>();

  const now = deps.now ?? Date.now;

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

  // sleeps LRU imps until `findMissing` reports nothing missing; false when
  // no imp is left to sleep
  const makeRoom = async (
    excludeId: string | null,
    reason: string,
    findMissing: (usage: UsageTotals) => number,
  ): Promise<boolean> => {
    for (;;) {
      const usage = await readEffectiveUsage(excludeId);

      const missing = findMissing(usage);

      if (missing <= 0) {
        return true;
      }

      const time = now();

      const candidates = usage.awake.map((imp) => ({
        id: imp.id,
        ramMib: usage.byImp.get(imp.id) ?? 0,
        lastActiveAt: imp.lastActiveAt,
        held: imp.holdUntil !== null && imp.holdUntil > time,
        busy: deps.isBusy(imp.id),
      }));

      const victims = pickSleepVictims(candidates, missing);

      if (victims === null || victims.length === 0) {
        return false;
      }

      let slept = 0;

      for (const id of victims) {
        const asleep = await deps.sleepImp(id, reason);

        if (asleep) {
          reservations.delete(id);

          slept += 1;
        }
      }

      if (slept === 0) {
        return false;
      }
    }
  };

  return {
    admit: (request) =>
      lock.runExclusive('admission', async () => {
        const fits = await makeRoom(
          request.id,
          `to make room for ${request.name}`,
          (usage) => usage.effectiveMib + request.reserveMib - deps.budgetMib,
        );

        if (!fits) {
          const usage = await readEffectiveUsage(request.id);

          throw buildRamBudgetError(deps.budgetMib, usage.effectiveMib, request.reserveMib);
        }

        reservations.set(request.id, {
          mib: request.reserveMib,
          until: now() + RESERVATION_TTL_MS,
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
        byImp: usage.byImp,
      };
    },

    enforce: () =>
      lock.runExclusive('admission', async () => {
        const fits = await makeRoom(
          null,
          'RAM over budget',
          (usage) => usage.usedMib - deps.budgetMib,
        );

        if (!fits) {
          deps.log('impd: governor: RAM over budget and no idle imp left to sleep');
        }
      }),
  };
}
