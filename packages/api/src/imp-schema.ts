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
  ip: z.ipv4(),
  slot: z.int().nonnegative(),
  port: z.int().positive(),
  httpPort: z.int().positive(),
  url: z.url(),
  createdAt: z.date(),
  lastActiveAt: z.date(),

  // RAM the awake VM owns now (anonymous pages), as the governor counts it
  ramMib: z.int().nonnegative().optional(),
  sleptAt: z.date().optional(),
  holdUntil: z.date().optional(),
  error: z.string().optional(),

  // sleeping: why the next wake boots cold instead of restoring the memory;
  // awake: why the last boot was cold instead of a wake
  coldBootReason: z.string().optional(),
  outdated: z.array(OutdatedPartSchema).readonly().optional(),
});

export type Imp = z.infer<typeof ImpSchema>;
