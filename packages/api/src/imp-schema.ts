import * as z from 'zod';
import { PublicAuthSchema } from './exposure-schema';
import { LeaseSummarySchema } from './lease-schema';
import { MoveStateSchema } from './move-schema';
import { NameSchema } from './name-schema';

export const ImpStateSchema = z.enum(['creating', 'running', 'sleeping', 'stopped', 'error']);

export type ImpState = z.infer<typeof ImpStateSchema>;

// a part of the host an imp's VM predates until its next cold boot; `impd`
// is a VM an impd from before vm.json booted, whose next wake boots cold
const OutdatedPartSchema = z.enum(['firecracker', 'kernel', 'agent', 'impd', 'ipv6']);

export type OutdatedPart = z.infer<typeof OutdatedPartSchema>;

// what the imp used: wakes and awake time from the record; the rest from
// impd's last sample of the running VM, every 5 s
const ImpResourcesSchema = z.object({
  wakeCount: z.int().nonnegative(),
  awakeMs: z.int().nonnegative(),

  // left out while the VM is not running or not sampled yet; the counters
  // run from `since`, when impd first saw this Firecracker: as its boot or
  // wake returned, or when impd adopted it
  sample: z
    .object({
      measuredAt: z.date(),
      since: z.date(),

      // of one core: 150 is one and a half; left out on the first sample
      cpuPercent: z.number().nonnegative().optional(),

      // time the CPU limit held the VM back
      cpuThrottledMs: z.int().nonnegative(),

      // from the guest's side: rx is what it received, tx what it sent
      netRxBytes: z.int().nonnegative(),
      netTxBytes: z.int().nonnegative(),
    })
    .optional(),
});

export const ImpSchema = z.object({
  id: z.string(),
  name: NameSchema,
  image: NameSchema,
  state: ImpStateSchema,
  vcpus: z.int().positive(),
  memoryMib: z.int().positive(),

  // what the guest may grow to with hot-plugged memory; left out for an imp
  // that does not grow
  maxMemoryMib: z.int().positive().optional(),

  // memory plugged into the awake guest beyond memoryMib, as last seen
  pluggedMib: z.int().nonnegative().optional(),

  // the disk's size; the guest's filesystem fills it
  diskMib: z.int().positive(),

  // what the imp's disk, checkpoints and memory take on the host, as last
  // measured: exclusive is what a destroy frees, shared what it holds with
  // an image, another imp or the backup tree. Left out until measured.
  diskUsage: z
    .object({
      exclusiveBytes: z.int().nonnegative(),
      sharedBytes: z.int().nonnegative(),
      measuredAt: z.date(),

      // the pass hit its time limit; a fork holds a snapshot (ZFS)
      isPartial: z.boolean(),
      isUpperBound: z.boolean(),
    })
    .optional(),
  ip: z.ipv4(),
  slot: z.int().nonnegative(),
  port: z.int().positive(),
  httpPort: z.int().positive(),
  url: z.url(),

  // set while the internet reaches https://<name>.<domain>, with what the
  // imp asks for before the wake; left out for a tailnet-only imp
  public: z.object({ auth: PublicAuthSchema }).optional(),
  createdAt: z.date(),
  lastActiveAt: z.date(),

  // RAM the awake VM owns now (anonymous pages), as the governor counts it
  ramMib: z.int().nonnegative().optional(),

  // the awake VM's resident memory on the host, clean pages of its memory
  // file included; more than ramMib after a wake, until the host drops them
  rssMib: z.int().nonnegative().optional(),
  sleptAt: z.date().optional(),

  // the latest end of the imp's leases, while one is live
  holdUntil: z.date().optional(),

  // its live leases, as the caller may see them; left out by an impd from
  // before leases
  leases: LeaseSummarySchema.optional(),
  error: z.string().optional(),

  // sessions in the imp, as last seen; left out while impd has not seen
  // the imp's agent yet
  sessions: z.int().nonnegative().optional(),

  // sleeping: why the next wake boots cold instead of restoring the memory;
  // awake: why the last boot was cold instead of a wake
  coldBootReason: z.string().optional(),

  // a running imp whose agent stopped answering: since when, once the
  // watchdog reports it
  agentSilentSince: z.date().optional(),
  outdated: z.array(OutdatedPartSchema).readonly().optional(),

  // cores the VM may use (null: no limit) and its share under contention,
  // the cgroup cpu.weight; left out by an impd from before CPU limits
  cpu: z.object({ limit: z.number().positive().nullable(), weight: z.int() }).optional(),
  resources: ImpResourcesSchema.optional(),

  // set while the imp moves to or from another host; nothing wakes or
  // changes it then
  move: MoveStateSchema.optional(),
});

export type Imp = z.infer<typeof ImpSchema>;
