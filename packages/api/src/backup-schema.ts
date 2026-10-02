import * as z from 'zod';

// one restic snapshot of the host: a point a restore can go back to
export const BackupPointSchema = z
  .object({
    id: z.string(),
    time: z.date(),

    // the imps it holds, by name
    imps: z.array(z.string()).readonly(),
  })
  .readonly();

export const BackupStatusSchema = z.object({
  points: z.array(BackupPointSchema).readonly(),
  lastRunAt: z.date().nullable(),
  lastPruneAt: z.date().nullable(),

  // a failed check means a damaged repository: restore from it with care
  lastCheck: z.object({ at: z.date(), error: z.string().optional() }).nullable(),
});

const BackupSkipSchema = z.object({ name: z.string(), reason: z.string() });

export const BackupRunSchema = z.object({
  snapshotId: z.string(),
  imps: z.array(z.string()).readonly(),

  // left out of this run: being created, removed or failing to copy
  skipped: z.array(BackupSkipSchema).readonly(),
  dataAddedBytes: z.int().nonnegative(),
  durationMs: z.int().nonnegative(),
});

// `--read-data-subset`: n/t, a percentage, or a size such as 2G
export const BackupCheckSubsetSchema = z
  .string()
  .regex(/^(?:\d+\/\d+|\d+(?:\.\d+)?%|\d+[KMGT]?)$/v);

export type BackupPoint = z.infer<typeof BackupPointSchema>;

export type BackupStatus = z.infer<typeof BackupStatusSchema>;

export type BackupRun = z.infer<typeof BackupRunSchema>;
