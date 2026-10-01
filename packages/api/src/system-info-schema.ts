import * as z from 'zod';

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
  firecrackerVersion: z.string().nullable(),
  tailscale: z.object({
    enabled: z.boolean(),
    state: z.string().nullable(),
    hostname: z.string().nullable(),
  }),
});

export type SystemInfo = z.infer<typeof SystemInfoSchema>;
