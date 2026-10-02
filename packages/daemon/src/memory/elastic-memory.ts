import { ORPCError } from '@orpc/server';

// Elastic memory (docs/architecture/memory.md): an imp boots with memoryMib
// and a virtio-mem region it can grow into, up to maxMemoryMib.

// Movable memory cannot hold the kernel's own allocations, so a guest that is
// mostly hot-plugged memory runs out of kernel memory first
// (docs/architecture/memory.md#limits).
const MAX_GROWTH_FACTOR = 4;

// virtio-mem's units: the region is whole slots, a plug or an unplug whole
// blocks (Firecracker's PUT /hotplug/memory)
export const SLOT_MIB = 128;
export const BLOCK_MIB = 2;

// the boot argument that onlines hot-plugged memory as movable, so that an
// unplug can migrate pages away; an imp that does not grow boots without it
export const ONLINE_MOVABLE_ARG = 'memhp_default_state=online_movable';

// A grow is one step: big enough that a burst does not need a tick per
// block, small enough that the governor seldom sleeps an imp for it.
export const GROW_STEP_MIB = 256;

// a guest with less than this free grows: the larger of 128 MiB and 15 % of
// what it has. The stats lag up to 1 s and a tick is 500 ms, so the margin
// covers a burst of about 100 MiB/s (docs/architecture/memory.md#growing).
const LOW_FLOOR_MIB = 128;
const LOW_FRACTION = 0.15;

// The guest's struct pages for plugged memory, paid in its base memory: 64
// bytes per 4 KiB page. Measured: 3 GiB plugged cost 48 MiB, and an unplugged
// region nothing (docs/architecture/memory.md#what-it-costs).
const STRUCT_PAGE_MIB_PER_GIB = 16;

// the hot-plug region of an imp, in MiB: whole slots covering max − memory;
// 0 for an imp that does not grow
export function findRegionMib(memoryMib: number, maxMemoryMib: number): number {
  const growth = maxMemoryMib - memoryMib;

  return growth <= 0 ? 0 : Math.ceil(growth / SLOT_MIB) * SLOT_MIB;
}

// below this much available, a guest of `totalMib` grows
export function findLowMib(totalMib: number): number {
  return Math.max(LOW_FLOOR_MIB, totalMib * LOW_FRACTION);
}

// The least total that leaves a guest using `usedMib` a step more available
// than its grow mark, so that a shrink to it is not undone by the next grow.
export function findSpareTotalMib(usedMib: number): number {
  return Math.max(
    usedMib + LOW_FLOOR_MIB + GROW_STEP_MIB,
    Math.ceil((usedMib + GROW_STEP_MIB) / (1 - LOW_FRACTION)),
  );
}

// what a plug of `mib` costs the host beyond the memory itself
export function findStructPageMib(mib: number): number {
  return Math.ceil((mib * STRUCT_PAGE_MIB_PER_GIB) / 1024);
}

// The max an imp is created with: memoryMib by default; a smaller one, or one
// past MAX_GROWTH_FACTOR × memoryMib, is refused.
export function resolveMaxMemoryMib(memoryMib: number, requested: number | undefined): number {
  if (requested === undefined) {
    return memoryMib;
  }

  if (requested < memoryMib) {
    throw new ORPCError('BAD_REQUEST', {
      message: `the max memory (${String(requested)} MiB) is less than the memory (${String(memoryMib)} MiB)`,
    });
  }

  const ceiling = memoryMib * MAX_GROWTH_FACTOR;

  if (requested > ceiling) {
    throw new ORPCError('BAD_REQUEST', {
      message: `the max memory (${String(requested)} MiB) is more than ${String(MAX_GROWTH_FACTOR)} × the memory (${String(ceiling)} MiB): memory the guest grows into cannot hold its kernel's own allocations, so raise the memory too`,
    });
  }

  return requested;
}

// rounds up to whole blocks
export function toWholeBlocks(mib: number): number {
  return Math.ceil(mib / BLOCK_MIB) * BLOCK_MIB;
}
