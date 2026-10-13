import type { GuestMemory, VmRunner } from '../vmm/vm-runner';
import { findSpareTotalMib, toWholeBlocks } from './elastic-memory';

// how often a shrink looks whether the guest got there, and how long the
// plugged size may stand still before the unplug counts as stopped
const POLL_MS = 100;
const STALL_MS = 500;

type GuestMemoryVm = Pick<VmRunner, 'readGuestMemory' | 'requestPluggedMib'>;

interface ShrinkOptions {
  readonly timeLimitMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

// The plugged size that leaves the guest a step more available than its grow
// mark, never below 0; the guest's base memory comes first.
export function findShrinkTargetMib(memory: Readonly<GuestMemory>): number {
  const usedMib = memory.totalMib - memory.availableMib;
  const baseMib = memory.totalMib - memory.pluggedMib;

  return Math.max(0, toWholeBlocks(findSpareTotalMib(usedMib) - baseMib));
}

// What a shrink saw: the guest as its first read found it, the most it held
// plugged in any read, as a plug under way may still move after the first,
// and the MiB it holds at the end, or will once a plug under way ends.
export interface ShrinkResult {
  readonly before: Readonly<GuestMemory>;
  readonly reachedMib: number;
  readonly pluggedMib: number;
}

// Unplugs toward the shrink target until the guest gets there, stops moving
// (then asks it back to what it reached), or the time limit passes.
export async function shrinkGuest(
  vm: GuestMemoryVm,
  paths: Parameters<GuestMemoryVm['readGuestMemory']>[0],
  options: Readonly<ShrinkOptions>,
): Promise<ShrinkResult> {
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeLimitMs;

  const before = await vm.readGuestMemory(paths);

  const targetMib = findShrinkTargetMib(before);

  // nothing to give back; a plug under way may still add up to its request
  if (targetMib >= before.pluggedMib) {
    return {
      before,
      reachedMib: before.pluggedMib,
      pluggedMib: Math.max(before.pluggedMib, before.requestedMib),
    };
  }

  await vm.requestPluggedMib(paths, targetMib);

  const moved = { pluggedMib: before.pluggedMib, at: now() };
  const reached = { mib: before.pluggedMib };

  for (;;) {
    await sleep(POLL_MS);

    const seen = await vm.readGuestMemory(paths);

    reached.mib = Math.max(reached.mib, seen.pluggedMib);

    if (seen.pluggedMib <= targetMib) {
      return { before, reachedMib: reached.mib, pluggedMib: seen.pluggedMib };
    }

    if (seen.pluggedMib !== moved.pluggedMib) {
      moved.pluggedMib = seen.pluggedMib;
      moved.at = now();
    }

    if (now() - moved.at >= STALL_MS || now() >= deadline) {
      await vm.requestPluggedMib(paths, seen.pluggedMib);

      return { before, reachedMib: reached.mib, pluggedMib: seen.pluggedMib };
    }
  }
}
