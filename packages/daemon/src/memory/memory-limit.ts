// The host's hard limit on an imp's memory, which follows what its guest may
// hold: the cgroups write it as memory.max. The callers raise it first and
// lower it last (docs/architecture/memory.md#the-host-limit).
export interface MemoryLimit {
  // `guestMib` is the guest's base memory plus what is plugged; the writer
  // adds the VMM's own overhead
  readonly setGuestMib: (impId: string, guestMib: number) => void;
}

export const NO_MEMORY_LIMIT: MemoryLimit = { setGuestMib: () => {} };
