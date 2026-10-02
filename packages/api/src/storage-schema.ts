import * as z from 'zod';

// what a GC removed, or would remove in a dry run: an imp's disk and
// directory, a checkpoint, an image, a ZFS fork or backup snapshot, or an
// imp's memory snapshot
export const DroppedStorageSchema = z
  .object({
    kind: z.enum(['imp', 'checkpoint', 'image', 'snapshot', 'memory']),
    id: z.string(),
  })
  .readonly();

export type DroppedStorage = z.infer<typeof DroppedStorageSchema>;

export const StorageGcSchema = z
  .object({
    dryRun: z.boolean(),
    dropped: z.array(DroppedStorageSchema).readonly(),
  })
  .readonly();

export type StorageGc = z.infer<typeof StorageGcSchema>;
