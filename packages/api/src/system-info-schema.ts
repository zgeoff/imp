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

// the last pass over the public imps' DNS records, or a read of the DNS
// API token as system info is asked for
const PassStatusSchema = z.object({
  isOk: z.boolean(),
  error: z.string().nullable(),
  at: z.date(),
});

const HttpsInfoSchema = z.object({
  domain: z.string(),

  // the token file, read as system info is asked for; null for a token
  // from the env or a provider without one. An error names the file,
  // never the token
  dnsToken: PassStatusSchema.nullable(),
});

const PublicInfoSchema = z.object({
  ip: z.ipv4(),
  imps: CountSchema,

  // null before the first pass
  records: PassStatusSchema.nullable(),
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

  // the memory sleeping imps were given, which their wakes take back;
  // optional for an impd from before it
  ramSleepingMib: z.int().nonnegative().optional(),
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

  // KSM's saving and the RAM the governor keeps free for it; null when IMP_KSM
  // is off, absent from an impd older than it. profitMib is general_profit,
  // which goes negative while KSM's metadata outweighs what it merged
  ksm: z
    .object({
      running: z.boolean(),
      sharedMib: CountSchema,
      profitMib: z.int(),
      zeroMib: CountSchema,
      headroomMib: CountSchema,

      // awake imps whose guest memory KSM cannot merge
      unmergeable: CountSchema,
    })
    .nullable()
    .optional(),

  // the host's cores, the most a CPU limit may be; whether limits hold
  // (false outside a private cgroup v2 namespace: they are kept, not applied)
  cpu: z.object({ hostCpus: z.int().positive(), limitsEnforced: z.boolean() }).optional(),

  // what a create gets when it names no memory or image: image is the
  // image impd would pick now, null when it has none. Optional for an impd
  // from before it.
  defaults: z.object({ memoryMib: z.int().positive(), image: z.string().nullable() }).optional(),

  // whether nft enforces the public, box and none egress policies; an impd
  // that cannot refuses them. Optional for an impd from before it.
  egress: z.object({ isEnforced: z.boolean() }).optional(),

  // public imps (docs/guides/https.md#public-imps): the IP their records
  // point at, and how many there are; null without IMP_PUBLIC_IP. Optional
  // for an impd from before them.
  public: PublicInfoSchema.nullable().optional(),

  // HTTPS on IMP_DOMAIN (docs/guides/https.md); null without it. Optional
  // for an impd from before it.
  https: HttpsInfoSchema.nullable().optional(),

  // what this impd can do; an impd without it has none of them.
  // `sessionOffsets` says only that impd can carry offsets: each session's
  // continuity decides, as an imp runs its old agent until a cold boot.
  features: z
    .object({
      sessionOffsets: z.boolean(),
      leases: z.boolean(),

      // tokens.create takes `grantable`, and secrets.add takes `rebind`; an
      // older impd drops both unread, so a client checks first
      grantableTokens: z.boolean().optional(),
      secretRebind: z.boolean().optional(),

      // system.copyDatabase; from 0.30.0
      databaseCopy: z.boolean().optional(),

      // POST /images/build streams build events to a client that accepts
      // them (docs/guides/images.md#build-an-image)
      imageBuildStream: z.boolean().optional(),

      // images.addStream and images.buildStream
      imageOpStream: z.boolean().optional(),

      // an `/exec` start takes `require`, which an older impd drops unread
      execRequire: z.boolean().optional(),

      // the oauth procedures and the public MCP route exist; the route runs
      // only where the operator turned it on (publicMcp)
      oauthGrants: z.boolean().optional(),

      // system.gc takes `secretFiles`; an older impd drops it unread and
      // never lists the secret values it kept aside
      secretFilesGc: z.boolean().optional(),

      // the `public` egress policy; an older impd refuses the mode
      publicEgress: z.boolean().optional(),
    })
    .optional(),
});

export type SystemInfo = z.infer<typeof SystemInfoSchema>;
