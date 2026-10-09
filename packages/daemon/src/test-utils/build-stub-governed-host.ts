import type { RamGovernor, RamGovernorDeps } from '../governor/ram-governor';
import { createKeyedMutex } from '../imps/keyed-mutex';
import { createLockFreeSleep } from '../imps/lock-free-sleep';
import type { SleepOutcome } from '../imps/lock-free-sleep';

interface HostImp {
  awake: boolean;
  rssMib: number;
  lastActiveAt: number;
  held: boolean;
  busy: boolean;

  // its snapshot fails: a sleep fails and leaves it awake
  failsSleep: boolean;

  // what an elastic guest can unplug when the governor reclaims
  spareMib: number;
}

// a change to the host between two governor calls
export type HostChange =
  | { readonly kind: 'rss'; readonly id: string; readonly mib: number }
  | { readonly kind: 'hold'; readonly id: string; readonly on: boolean }
  | { readonly kind: 'busy'; readonly id: string; readonly on: boolean }
  | { readonly kind: 'failSleep'; readonly id: string; readonly on: boolean }
  | { readonly kind: 'spare'; readonly id: string; readonly mib: number }
  | { readonly kind: 'touch'; readonly id: string }
  | { readonly kind: 'stop'; readonly id: string }
  | { readonly kind: 'tick'; readonly ms: number };

interface StubGovernedHostOptions {
  readonly budgetMib: number;
  readonly ids: readonly string[];

  // the imps awake at the start, least recently active first
  readonly awake: readonly {
    readonly id: string;
    readonly rssMib: number;
    readonly failsSleep?: boolean;
  }[];
}

// far past any clock a case reaches: a hold that never expires on its own
const HELD_FOREVER = Number.MAX_SAFE_INTEGER;

// measured usage over the budget, and how many imps the governor may still
// sleep: an imp whose sleep fails does not count
export interface RoomLeft {
  readonly overMib: number;
  readonly eligibleAwake: number;
}

// A model host of imps for the RAM governor. `pacer.pace` runs before each
// read and sleep; a sleep refuses a held or busy imp at call time, as the
// real one does under the imp's lock.
export function buildStubGovernedHost(options: Readonly<StubGovernedHostOptions>) {
  const imps = new Map<string, HostImp>(
    options.ids.map((id) => [
      id,
      {
        awake: false,
        rssMib: 0,
        lastActiveAt: 0,
        held: false,
        busy: false,
        failsSleep: false,
        spareMib: 0,
      },
    ]),
  );

  for (const [index, imp] of options.awake.entries()) {
    imps.set(imp.id, {
      awake: true,
      rssMib: imp.rssMib,
      lastActiveAt: index,
      held: false,
      busy: false,
      failsSleep: imp.failsSleep ?? false,
      spareMib: 0,
    });
  }

  const clock = { now: 1_000_000 };
  const pacer: { pace: () => Promise<void> } = { pace: () => Promise.resolve() };

  const sleepCalls: {
    readonly id: string;
    readonly eligible: boolean;
    readonly outcome: SleepOutcome;
  }[] = [];

  const mutex = createKeyedMutex();

  const findImp = (id: string): HostImp => {
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
      const failedOutcome = imp.failsSleep ? 'failed' : 'slept';
      const outcome: SleepOutcome = eligible ? failedOutcome : 'skipped';

      sleepCalls.push({ id, eligible, outcome });

      if (outcome === 'slept') {
        imp.awake = false;
      }

      return outcome;
    },
  );

  const deps = {
    budgetMib: options.budgetMib,
    listAwake: async (): ReturnType<RamGovernorDeps['listAwake']> => {
      await pacer.pace();

      return [...imps]
        .filter(([, imp]) => imp.awake)
        .map(([id, imp]) => ({
          id,
          name: id,
          pid: options.ids.indexOf(id) + 1,

          // the id, which readRamMib reads back
          apiSocket: id,
          lastActiveAt: imp.lastActiveAt,
          holdUntil: imp.held ? HELD_FOREVER : null,
        }));
    },
    readRamMib: (_pid: number, id: string): number | null =>
      imps.get(id)?.awake === true ? findImp(id).rssMib : null,
    isBusy: (id: string): boolean => findImp(id).busy,
    trySleepImp,

    // idle elastic guests give back what they can spare
    reclaim: async (excludeId: string | null): Promise<number> => {
      await pacer.pace();

      const givers = [...imps].filter(([id, imp]) => imp.awake && !imp.busy && id !== excludeId);

      return givers.reduce((freedMib, [, imp]) => {
        const mib = Math.min(imp.spareMib, imp.rssMib);

        imp.rssMib -= mib;
        imp.spareMib = 0;

        return freedMib + mib;
      }, 0);
    },
    now: (): number => clock.now,
  } satisfies Omit<RamGovernorDeps, 'log'>;

  return {
    imps,
    pacer,
    sleepCalls,
    deps,
    findImp,

    // an admitted imp is awake and measures nothing yet
    markAdmitted: (id: string): void => {
      Object.assign(findImp(id), { awake: true, rssMib: 0, lastActiveAt: clock.now });
    },

    // What an asleep imp holds reserved, 0 for an awake one. Asleep, its
    // reservation counts in full; awake with a huge measurement it counts
    // nothing, since an awake imp counts the larger of the two.
    readReservation: async (
      id: string,
      governor: Pick<RamGovernor, 'readUsage'>,
    ): Promise<number> => {
      const imp = findImp(id);

      if (imp.awake) {
        return 0;
      }

      const asleep = await governor.readUsage();

      Object.assign(imp, { awake: true, rssMib: 1_000_000 });

      const measured = await governor.readUsage();

      Object.assign(imp, { awake: false, rssMib: 0 });

      return asleep.reservedMib - measured.reservedMib;
    },

    findRoomLeft: (): RoomLeft => {
      const awake = [...imps.values()].filter((imp) => imp.awake);
      const usedMib = awake.reduce((sum, imp) => sum + imp.rssMib, 0);

      return {
        overMib: usedMib - options.budgetMib,
        eligibleAwake: awake.filter((imp) => !imp.held && !imp.busy && !imp.failsSleep).length,
      };
    },

    // a stop also tells the governor, as the lifecycle does
    applyChange: (change: HostChange, governor: Pick<RamGovernor, 'release'>): void => {
      if (change.kind === 'tick') {
        clock.now += change.ms;

        return;
      }

      const imp = findImp(change.id);

      switch (change.kind) {
        case 'rss': {
          imp.rssMib = change.mib;
          break;
        }
        case 'hold': {
          imp.held = change.on;
          break;
        }
        case 'busy': {
          imp.busy = change.on;
          break;
        }
        case 'failSleep': {
          imp.failsSleep = change.on;
          break;
        }
        case 'spare': {
          imp.spareMib = change.mib;
          break;
        }
        case 'touch': {
          imp.lastActiveAt = clock.now;
          break;
        }
        case 'stop': {
          imp.awake = false;

          governor.release(change.id);
          break;
        }
      }
    },
  };
}
