import * as z from 'zod';
import { NameSchema } from './name-schema';

export const ImpStateSchema = z.enum(['creating', 'running', 'sleeping', 'stopped', 'error']);

export type ImpState = z.infer<typeof ImpStateSchema>;

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
  url: z.url(),
  createdAt: z.date(),
  lastActiveAt: z.date(),
  sleptAt: z.date().optional(),
  holdUntil: z.date().optional(),
  error: z.string().optional(),
});

export type Imp = z.infer<typeof ImpSchema>;
