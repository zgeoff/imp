import * as z from 'zod';

export const SystemInfoSchema = z.object({
  version: z.string(),
  ramBudgetMib: z.int().nonnegative(),
  ramUsedMib: z.int().nonnegative(),
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
