import * as z from 'zod';
import { ImpSchema } from './imp-schema';

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

  // left out of every run: created with backup off; an impd from before
  // the setting leaves it out
  excluded: z.array(BackupSkipSchema).readonly().optional(),
  dataAddedBytes: z.int().nonnegative(),
  durationMs: z.int().nonnegative(),
});

const SkippedGrantSchema = z.object({ imp: z.string(), secret: z.string(), reason: z.string() });
const NotRestorableSchema = z.object({ imp: z.string(), reason: z.string() });

// What a restore of all took from the backup's database copy: the named
// tokens by name, and the secrets, whose values a backup never holds. A
// token whose name this host has, or a key bound here, is left out.
const RestoredDatabaseSchema = z
  .object({
    tokens: z.array(z.string()).readonly(),
    secrets: z.array(z.string()).readonly(),
    skipped: z.array(BackupSkipSchema).readonly(),
  })
  .readonly();

// The restored imps, stopped. A grant names a secret on this host: one with
// no such secret, or that clashes, is left off and listed here.
export const BackupRestoreSchema = z
  .object({
    imps: z.array(ImpSchema).readonly(),
    skippedGrants: z.array(SkippedGrantSchema).readonly(),

    // imps created with backup off, which the backup holds no file of; an
    // impd from before the setting leaves it out
    notRestorable: z.array(NotRestorableSchema).readonly().optional(),

    // a restore of all from a backup that holds impd's database copy
    database: RestoredDatabaseSchema.optional(),
  })
  .readonly();

// `--read-data-subset`: n/t, a percentage, or a size such as 2G
export const BackupCheckSubsetSchema = z
  .string()
  .regex(/^(?:\d+\/\d+|\d+(?:\.\d+)?%|\d+[KMGT]?)$/v);

export type BackupPoint = z.infer<typeof BackupPointSchema>;

export type BackupStatus = z.infer<typeof BackupStatusSchema>;

export type BackupRun = z.infer<typeof BackupRunSchema>;

export type BackupRestore = z.infer<typeof BackupRestoreSchema>;
