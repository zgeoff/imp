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

  // the guest kernel and system drive imps boot with; version is null when
  // the kernel image has no version banner
  guestKernel: z.object({ version: z.string().nullable(), sha256: z.string() }),
  systemDrive: z.object({ sha256: z.string() }),
  tailscale: z.object({
    enabled: z.boolean(),
    state: z.string().nullable(),
    hostname: z.string().nullable(),
    ip: z.string().nullable(),
  }),
});

export type SystemInfo = z.infer<typeof SystemInfoSchema>;
