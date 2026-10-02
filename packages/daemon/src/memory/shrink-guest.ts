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

// Unplugs toward the shrink target until the guest gets there, stops moving
// (then asks it back to what it reached), or the time limit passes; returns
// the MiB it holds then, or will hold once a plug under way ends.
export async function shrinkGuest(
  vm: GuestMemoryVm,
  paths: Parameters<GuestMemoryVm['readGuestMemory']>[0],
  options: Readonly<ShrinkOptions>,
): Promise<number> {
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeLimitMs;

  const before = await vm.readGuestMemory(paths);

  const targetMib = findShrinkTargetMib(before);

  // nothing to give back; a plug under way may still add up to its request
  if (targetMib >= before.pluggedMib) {
    return Math.max(before.pluggedMib, before.requestedMib);
  }

  await vm.requestPluggedMib(paths, targetMib);

  const moved = { pluggedMib: before.pluggedMib, at: now() };

  for (;;) {
    await sleep(POLL_MS);

    const seen = await vm.readGuestMemory(paths);

    if (seen.pluggedMib <= targetMib) {
      return seen.pluggedMib;
    }

    if (seen.pluggedMib !== moved.pluggedMib) {
      moved.pluggedMib = seen.pluggedMib;
      moved.at = now();
    }

    if (now() - moved.at >= STALL_MS || now() >= deadline) {
      await vm.requestPluggedMib(paths, seen.pluggedMib);

      return seen.pluggedMib;
    }
  }
}
