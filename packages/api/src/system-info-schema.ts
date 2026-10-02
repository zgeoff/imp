import * as z from 'zod';

const CountSchema = z.int().nonnegative();

const BootStatusSchema = z.object({
  coldBoots: CountSchema,
  outdated: z.object({ firecracker: CountSchema, kernel: CountSchema, agent: CountSchema }),
});

export const SystemInfoSchema = z.object({
  version: z.string(),
  ramBudgetMib: z.int().nonnegative(),

  // measured: what awake VMs own now
  ramUsedMib: z.int().nonnegative(),

  // reserved for boots and wakes that the measurement does not show yet
  ramReservedMib: z.int().nonnegative(),

  // the memory awake imps were given; the most they can grow to
  ramCommittedMib: z.int().nonnegative(),
  awakeCount: z.int().nonnegative(),
  impCount: z.int().nonnegative(),

  // sessions across every imp, as last seen
  sessionCount: z.int().nonnegative(),

  // what an upgrade left, over running and sleeping imps: how many boot cold
  // on their next wake, and how many run each part older than the host's
  // until their next cold boot
  bootStatus: BootStatusSchema,
  firecrackerVersion: z.string().nullable(),

  // the guest kernel and system drive imps boot with; version is null when
  // the kernel image has no version banner
  guestKernel: z.object({ version: z.string().nullable(), sha256: z.string() }),
  systemDrive: z.object({ sha256: z.string() }),

  // the filesystem or pool that holds disks, checkpoints and images
  storage: z.object({
    backend: z.enum(['xfs', 'zfs']),
    usedBytes: z.int().nonnegative(),
    availableBytes: z.int().nonnegative(),

    // free space no write may take (IMP_DISK_RESERVE_GIB), and what writes
    // under way have promised; low: below twice the reserve
    reserveBytes: z.int().nonnegative(),
    pendingBytes: z.int().nonnegative(),
    isLow: z.boolean(),

    // the disk sizes of every imp: what the guests could fill, thin or not
    impDiskBytes: z.int().nonnegative(),
  }),
  tailscale: z.object({
    enabled: z.boolean(),
    state: z.string().nullable(),
    hostname: z.string().nullable(),
    ip: z.string().nullable(),
  }),
});

export type SystemInfo = z.infer<typeof SystemInfoSchema>;
