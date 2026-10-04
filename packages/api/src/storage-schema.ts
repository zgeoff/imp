import * as z from 'zod';

// what a GC removed, or would remove in a dry run: an imp's disk and
// directory, a checkpoint, an image, a ZFS fork or backup snapshot, an
// imp's memory snapshot, or a directory of kept secret values
export const DroppedStorageSchema = z
  .object({
    kind: z.enum(['imp', 'checkpoint', 'image', 'snapshot', 'memory', 'secrets']),
    id: z.string(),
  })
  .readonly();

export type DroppedStorage = z.infer<typeof DroppedStorageSchema>;

// What no row names and no crash provably explains, such as every disk after
// the database is lost. A GC keeps it unless asked for orphans. `secrets`, a
// directory of value files the broker kept aside, only with `secretFiles`.
export const OrphanStorageSchema = z
  .object({
    kind: z.enum(['imp', 'image', 'memory', 'checkpoint', 'secrets']),
    id: z.string(),

    // the ZFS dataset or snapshot, or the directory
    location: z.string(),

    // its snapshots or checkpoints included
    bytes: z.int().nonnegative(),
    createdAt: z.date().nullable(),

    // the names after `@` on ZFS, the checkpoint ids on XFS
    snapshots: z.array(z.string()).readonly(),

    // `secrets` only: the value files in the directory
    files: z.array(z.string()).readonly().optional(),
  })
  .readonly();

export type OrphanStorage = z.infer<typeof OrphanStorageSchema>;

// `kept`: the orphans a GC without `orphans` kept; an impd from before them
// leaves it out
export const StorageGcSchema = z
  .object({
    dryRun: z.boolean(),
    dropped: z.array(DroppedStorageSchema).readonly(),
    kept: z.array(OrphanStorageSchema).readonly().optional(),
  })
  .readonly();

export type StorageGc = z.infer<typeof StorageGcSchema>;

// a copy of impd's database, its schema version (last migration), the impd
// that wrote it, and integrity_check on it ('ok' or the first problem); a
// restore script reads these names
export const DatabaseCopySchema = z.object({
  path: z.string(),
  sizeBytes: z.int().nonnegative(),
  lastMigration: z.string(),
  impVersion: z.string(),
  createdAt: z.date(),
  integrity: z.string(),
});

export type DatabaseCopy = z.infer<typeof DatabaseCopySchema>;
