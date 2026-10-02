import * as z from 'zod';
import { NameSchema } from './name-schema';

const CountSchema = z.int().nonnegative();
const NameFailureSchema = z.object({ name: NameSchema, error: z.string() });

// per-imp names as Tailscale Services
const TailnetNamesSchema = z.object({
  live: CountSchema,
  failed: z.array(NameFailureSchema).readonly(),
});

const BootStatusSchema = z.object({
  coldBoots: CountSchema,
  outdated: z.object({
    firecracker: CountSchema,
    kernel: CountSchema,
    agent: CountSchema,

    // imps with no IPv6 until their next cold boot; left out by an older impd
    ipv6: CountSchema.optional(),
  }),
});

// the last pass over the public imps' DNS records
const RecordsStatusSchema = z.object({
  isOk: z.boolean(),
  error: z.string().nullable(),
  at: z.date(),
});

const PublicInfoSchema = z.object({
  ip: z.ipv4(),
  imps: CountSchema,

  // null before the first pass
  records: RecordsStatusSchema.nullable(),
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

    // null when IMP_TAILNET_NAMES is off
    names: TailnetNamesSchema.nullable(),
  }),

  // the host's cores, the most a CPU limit may be; whether limits hold
  // (false outside a private cgroup v2 namespace: they are kept, not applied)
  cpu: z.object({ hostCpus: z.int().positive(), limitsEnforced: z.boolean() }).optional(),

  // public imps (docs/guides/https.md#public-imps): the IP their records
  // point at, and how many there are; null without IMP_PUBLIC_IP. Optional
  // for an impd from before them.
  public: PublicInfoSchema.nullable().optional(),
});

export type SystemInfo = z.infer<typeof SystemInfoSchema>;
