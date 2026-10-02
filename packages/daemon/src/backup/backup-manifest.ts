import * as z from 'zod';

const LEGACY_DISK_BYTES = 32 * 1024 ** 3;

const ManifestCheckpointSchema = z
  .object({
    id: z.string(),
    label: z.string().nullable(),
    createdAt: z.coerce.date(),
    disk: z.string(),

    // a manifest from before disk sizes had 32 GiB disks only
    diskBytes: z.int().positive().default(LEGACY_DISK_BYTES),
  })
  .readonly();

const ManifestImpSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    imageDigest: z.string(),
    vcpus: z.int(),
    memoryMib: z.int(),
    httpPort: z.int(),
    state: z.string(),

    // false: the guest was not frozen, so the disk is as after a power cut
    synced: z.boolean(),
    dir: z.string(),
    disk: z.string(),

    // the database's size; the disk file in the tree has the size it had
    // when copied, which a resize during the run can pass
    diskBytes: z.int().positive().default(LEGACY_DISK_BYTES),

    // the broker's policy for hosts no grant covers, and the names of the
    // secrets granted: never a value (docs/architecture/backups.md#manifest)
    egressPolicy: z.string().default('open'),
    grants: z.array(z.string()).readonly().default([]),

    // oldest first
    checkpoints: z.array(ManifestCheckpointSchema).readonly(),
  })
  .readonly();

const ManifestImageSchema = z
  .object({
    name: z.string(),
    ref: z.string(),
    digest: z.string(),
    sizeBytes: z.int(),
    dir: z.string(),
  })
  .readonly();

// What a restore needs to rebuild each imp, and nothing more: no tokens, no
// secrets, no slots or addresses (docs/architecture/backups.md#manifest).
// Paths are relative to the backup tree.
export const BackupManifestSchema = z
  .object({
    version: z.literal(1),
    runId: z.string(),
    createdAt: z.coerce.date(),
    imps: z.array(ManifestImpSchema).readonly(),
    images: z.array(ManifestImageSchema).readonly(),
  })
  .readonly();

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export type ManifestImp = z.infer<typeof ManifestImpSchema>;

export type ManifestImage = z.infer<typeof ManifestImageSchema>;
