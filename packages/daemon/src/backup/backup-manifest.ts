import { ImageSourceSchema } from '@imp/api';
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

    // the blocks the file held in the tree; older manifests leave it out
    usedBytes: z.int().nonnegative().optional(),
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
    usedBytes: z.int().nonnegative().optional(),

    // the egress policy's mode and allow-list, and the names of the secrets
    // granted: never a value (docs/architecture/backups.md#the-manifest)
    egressPolicy: z.string().default('open'),
    egressAllow: z.array(z.string()).readonly().default([]),
    grants: z.array(z.string()).readonly().default([]),

    // a template copy whose first boot has not reset its identity yet
    identityResetPending: z.boolean().default(false),

    // oldest first
    checkpoints: z.array(ManifestCheckpointSchema).readonly(),
  })
  .readonly();

const ManifestImageSchema = z
  .object({
    name: z.string(),
    ref: z.string(),
    digest: z.string(),

    // a template has no docker ref to pull again, so a restore of all brings
    // it back with no imp on it; oci in a backup from before templates
    source: ImageSourceSchema.default('oci'),

    // a template's source imp, which a limited token must reach to copy it
    sourceImp: z.string().nullable().default(null),
    sizeBytes: z.int(),
    dir: z.string(),
  })
  .readonly();

// What a restore needs to rebuild each imp, and nothing more: no tokens, no
// secrets, no slots or addresses (docs/architecture/backups.md#the-manifest).
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
