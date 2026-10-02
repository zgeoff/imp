import * as z from 'zod';
import { NameSchema } from './name-schema';

export const ImpStateSchema = z.enum(['creating', 'running', 'sleeping', 'stopped', 'error']);

export type ImpState = z.infer<typeof ImpStateSchema>;

// a part of the host an imp's VM predates until its next cold boot; `impd`
// is a VM an impd from before vm.json booted, whose next wake boots cold
const OutdatedPartSchema = z.enum(['firecracker', 'kernel', 'agent', 'impd']);

export type OutdatedPart = z.infer<typeof OutdatedPartSchema>;

export const ImpSchema = z.object({
  id: z.string(),
  name: NameSchema,
  image: NameSchema,
  state: ImpStateSchema,
  vcpus: z.int().positive(),
  memoryMib: z.int().positive(),

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
  createdAt: z.date(),
  lastActiveAt: z.date(),

  // RAM the awake VM owns now (anonymous pages), as the governor counts it
  ramMib: z.int().nonnegative().optional(),

  // the awake VM's resident memory on the host, clean pages of its memory
  // file included; more than ramMib after a wake, until the host drops them
  rssMib: z.int().nonnegative().optional(),
  sleptAt: z.date().optional(),
  holdUntil: z.date().optional(),
  error: z.string().optional(),

  // sessions in the imp, as last seen; left out while impd has not seen
  // the imp's agent yet
  sessions: z.int().nonnegative().optional(),

  // sleeping: why the next wake boots cold instead of restoring the memory;
  // awake: why the last boot was cold instead of a wake
  coldBootReason: z.string().optional(),
  outdated: z.array(OutdatedPartSchema).readonly().optional(),
});

export type Imp = z.infer<typeof ImpSchema>;
