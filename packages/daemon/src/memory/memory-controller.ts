import type { GrowRequest } from '../governor/ram-governor';
import type { ImpPaths } from '../storage/data-layout';
import type { GuestMemory, VmRunner } from '../vmm/vm-runner';
import { GROW_STEP_MIB, findLowMib, findRegionMib, findStructPageMib } from './elastic-memory';
import type { MemoryLimit } from './memory-limit';
import { findShrinkTargetMib, shrinkGuest } from './shrink-guest';

// a guest that could give back a step for this long shrinks
const SHRINK_AFTER_MS = 60_000;

// a plug or an unplug the guest cannot finish (memory it cannot online or
// migrate) is not asked again in that direction for this long
const BACKOFF_MS = 60_000;

// what a reclaim waits for each guest's unplug under the governor's lock
const RECLAIM_TIME_LIMIT_MS = 1000;

// a plug or an unplug whose plugged size stands still this long has stopped
const STALL_MS = 2000;

export interface ElasticImp {
  readonly id: string;
  readonly name: string;
  readonly pid: number;
  readonly memoryMib: number;
  readonly maxMemoryMib: number;
  readonly paths: ImpPaths;
}

export interface MemoryControllerDeps {
  // the running imps whose max is above their memory
  readonly listElastic: () => Promise<readonly ElasticImp[]>;
  readonly vms: Pick<VmRunner, 'readGuestMemory' | 'requestPluggedMib'>;

  // a lifecycle operation holds the imp's lock: the controller leaves it be
  readonly isLocked: (id: string) => boolean;

  // an open exec session, proxied request or hold: a reclaim leaves it be
  readonly isBusy: (id: string) => boolean;

  // runs `action` under the imp's lifecycle lock when the lock is free and
  // the imp still runs; false when it did not run. A plug or an unplug goes
  // through it, so that a sleep never sees its guest change size.
  readonly tryWhileRunning: (id: string, action: () => Promise<void>) => Promise<boolean>;

  // the governor's admission for a grow, which reserves it; false when it
  // refused. A grow that then cannot plug gives the reservation back.
  readonly admitGrow: (request: GrowRequest) => Promise<boolean>;
  readonly releaseGrow: (id: string) => void;
  readonly limit: MemoryLimit;

  // the RAM the VM owns now, as the governor counts it
  readonly readRamMib: (imp: ElasticImp) => number | null;

  // what the guest holds, for the API; null when it is not known
  readonly setPluggedMib: (id: string, mib: number | null) => void;
  readonly log: (message: string) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface ImpState {
  // since when the guest could give back a step
  spareSince: number | null;

  // no shrink before this, after an unplug that stopped partway; no grow
  // before growAfter, after a plug that did
  shrinkAfter: number;
  growAfter: number;

  // a plug or an unplug under way: where it stood, and since when
  change: { pluggedMib: number; since: number } | null;

  // a stopped plug is logged once, until the guest's size moves again
  stalledAtMib: number | null;

  // a limit to lower once the guest holds no more than it and its RSS fell
  lowerTo: number | null;

  // a refused grow is logged once until a grow goes through again
  isRefused: boolean;
}

export interface MemoryController {
  // one look at every elastic imp: grow, shrink, or nothing
  readonly runTick: () => Promise<void>;

  // the governor's step before it sleeps imps: idle elastic imps unplug to
  // their spare size; returns the MiB unplugged
  readonly reclaimIdle: (excludeId: string | null) => Promise<number>;
}

// Grows elastic guests under pressure and shrinks them when they have memory
// to spare. A guest grows only here, through the governor's admission;
// refused, it stays at its size (docs/architecture/memory.md#growing).
export function createMemoryController(deps: MemoryControllerDeps): MemoryController {
  const now = deps.now ?? Date.now;

  const states = new Map<string, ImpState>();

  // seen for the first time: a new boot or a VM impd re-adopted, whose
  // plugged size the limit must cover
  const readState = (imp: ElasticImp, memory: Readonly<GuestMemory>): ImpState => {
    const known = states.get(imp.id);

    if (known !== undefined) {
      return known;
    }

    const created: ImpState = {
      spareSince: null,
      shrinkAfter: 0,
      growAfter: 0,
      change: null,
      stalledAtMib: null,
      lowerTo: null,
      isRefused: false,
    };

    states.set(imp.id, created);

    deps.limit.setGuestMib(
      imp.id,
      imp.memoryMib + Math.max(memory.pluggedMib, memory.requestedMib),
    );

    return created;
  };

  // the limit comes down once the unplug is done and the RSS is under it
  const applyLowerLimit = (imp: ElasticImp, memory: Readonly<GuestMemory>): void => {
    const state = readState(imp, memory);

    if (state.lowerTo === null || memory.requestedMib > memory.pluggedMib) {
      return;
    }

    const guestMib = imp.memoryMib + memory.pluggedMib;

    if (memory.pluggedMib > state.lowerTo || (deps.readRamMib(imp) ?? guestMib) > guestMib) {
      return;
    }

    deps.limit.setGuestMib(imp.id, guestMib);

    state.lowerTo = null;
  };

  // a plug or an unplug under the imp's lock; `before` runs first under it
  const sendLocked = (imp: ElasticImp, mib: number, before = () => {}) =>
    deps.tryWhileRunning(imp.id, async () => {
      before();

      await deps.vms.requestPluggedMib(imp.paths, mib);
    });

  const growImp = async (imp: ElasticImp, memory: Readonly<GuestMemory>) => {
    const state = readState(imp, memory);

    const capMib = Math.min(
      findRegionMib(imp.memoryMib, imp.maxMemoryMib),
      imp.maxMemoryMib - imp.memoryMib,
    );

    const stepMib = Math.min(GROW_STEP_MIB, capMib - memory.pluggedMib);

    if (stepMib <= 0) {
      return;
    }

    const admitted = await deps.admitGrow({
      id: imp.id,
      name: imp.name,
      mib: stepMib + findStructPageMib(stepMib),
    });

    if (!admitted) {
      if (!state.isRefused) {
        deps.log(
          `impd: ${imp.name}: memory low (${String(memory.availableMib)} MiB free), and the RAM budget has no room to grow it`,
        );
      }

      state.isRefused = true;

      return;
    }

    state.isRefused = false;

    const pluggedMib = memory.pluggedMib + stepMib;

    // the host lets the guest have it before the guest takes it
    const isRequested = await sendLocked(imp, pluggedMib, () => {
      deps.limit.setGuestMib(imp.id, imp.memoryMib + pluggedMib);
    });

    // a sleep or stop took the imp since the tick looked
    if (!isRequested) {
      deps.releaseGrow(imp.id);

      return;
    }

    state.lowerTo = null;

    deps.log(`impd: ${imp.name}: memory low, grew to ${String(imp.memoryMib + pluggedMib)} MiB`);
  };

  // an unplug toward the spare size; the guest gets there in its own time,
  // and a later tick sees whether it did
  const shrinkImp = async (imp: ElasticImp, memory: Readonly<GuestMemory>) => {
    const state = readState(imp, memory);
    const targetMib = findShrinkTargetMib(memory);

    state.spareSince = null;

    if (!(await sendLocked(imp, targetMib))) {
      return;
    }

    state.lowerTo = targetMib;

    deps.log(
      `impd: ${imp.name}: memory to spare, shrinking to ${String(imp.memoryMib + targetMib)} MiB`,
    );
  };

  // A plug or an unplug that stands still has stopped: the guest keeps what
  // it reached, impd asks for exactly that, and backs off that direction.
  const checkChange = async (imp: ElasticImp, memory: Readonly<GuestMemory>, time: number) => {
    const state = readState(imp, memory);

    if (state.change?.pluggedMib !== memory.pluggedMib) {
      state.change = { pluggedMib: memory.pluggedMib, since: time };

      return;
    }

    if (time - state.change.since < STALL_MS) {
      return;
    }

    const isPlug = memory.requestedMib > memory.pluggedMib;

    if (!(await sendLocked(imp, memory.pluggedMib))) {
      return;
    }

    const guestMib = String(imp.memoryMib + memory.pluggedMib);

    state.change = null;
    state.lowerTo = memory.pluggedMib;

    if (!isPlug) {
      state.shrinkAfter = time + BACKOFF_MS;

      deps.log(`impd: ${imp.name}: the guest could not unplug below ${guestMib} MiB`);

      return;
    }

    state.growAfter = time + BACKOFF_MS;

    if (state.stalledAtMib === null) {
      deps.log(`impd: ${imp.name}: the guest could not plug past ${guestMib} MiB`);
    }

    state.stalledAtMib = memory.pluggedMib;
  };

  const checkImp = async (imp: ElasticImp): Promise<void> => {
    const memory = await deps.vms.readGuestMemory(imp.paths);

    const state = readState(imp, memory);
    const time = now();

    deps.setPluggedMib(imp.id, memory.pluggedMib);

    // a plug or an unplug under way: still moving, or stopped partway
    if (memory.requestedMib !== memory.pluggedMib) {
      await checkChange(imp, memory, time);

      return;
    }

    state.change = null;

    if (memory.pluggedMib !== state.stalledAtMib) {
      state.stalledAtMib = null;
    }

    applyLowerLimit(imp, memory);

    if (memory.availableMib < findLowMib(memory.totalMib)) {
      state.spareSince = null;

      if (time >= state.growAfter) {
        await growImp(imp, memory);
      }

      return;
    }

    const isSpare =
      memory.pluggedMib - findShrinkTargetMib(memory) >= GROW_STEP_MIB && time >= state.shrinkAfter;

    if (!isSpare) {
      state.spareSince = null;

      return;
    }

    state.spareSince ??= time;

    if (time - state.spareSince >= SHRINK_AFTER_MS) {
      await shrinkImp(imp, memory);
    }
  };

  return {
    runTick: async () => {
      const imps = await deps.listElastic();

      const seen = new Set(imps.map((imp) => imp.id));

      // a sleep, stop or destroy ends what the controller knew
      for (const id of states.keys()) {
        if (!seen.has(id)) {
          states.delete(id);
          deps.setPluggedMib(id, null);
        }
      }

      for (const imp of imps) {
        if (deps.isLocked(imp.id)) {
          continue;
        }

        try {
          await checkImp(imp);
        } catch {
          // a VM that is pausing or gone; the next tick looks again
        }
      }
    },
    reclaimIdle: async (excludeId) => {
      const imps = await deps.listElastic();

      const idle = imps.filter((imp) => imp.id !== excludeId && !deps.isBusy(imp.id));

      // a guest's whole unplug runs under its lock, like a sleep's
      const shrinkIdleImp = async (imp: ElasticImp): Promise<number> => {
        const freed = { mib: 0 };

        await deps.tryWhileRunning(imp.id, async () => {
          const before = await deps.vms.readGuestMemory(imp.paths);

          const afterMib = await shrinkGuest(deps.vms, imp.paths, {
            timeLimitMs: RECLAIM_TIME_LIMIT_MS,
            ...(deps.sleep !== undefined && { sleep: deps.sleep }),
            now,
          });

          deps.setPluggedMib(imp.id, afterMib);

          const state = states.get(imp.id);

          if (state !== undefined && afterMib < before.pluggedMib) {
            state.lowerTo = afterMib;
          }

          // a plug under way gives nothing back
          freed.mib = Math.max(0, before.pluggedMib - afterMib);
        });

        return freed.mib;
      };

      const freed = await Promise.all(idle.map((imp) => shrinkIdleImp(imp).catch(() => 0)));

      return freed.reduce((sum, mib) => sum + mib, 0);
    },
  };
}
