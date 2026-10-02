import { ImageSourceSchema, WarmMoveSchema } from '@imp/api';
import * as z from 'zod';
import { SnapshotMetaSchema } from '../sleep/snapshot-meta';
import { VmIdentitySchema } from '../sleep/vm-identity';

const CpuSchema = z.object({ limit: z.number().positive().nullable(), weight: z.int() }).readonly();

const EgressSchema = z
  .object({ mode: z.string(), allow: z.array(z.string()).readonly() })
  .readonly();

const CheckpointSchema = z
  .object({
    label: z.string().nullable(),
    createdAt: z.coerce.date(),
    diskBytes: z.int().positive(),
  })
  .readonly();

const ImpSchema = z
  .object({
    // it names the target's datasets and paths, so only a UUID
    id: z.uuid(),
    name: z.string(),
    vcpus: z.int().positive(),
    memoryMib: z.int().positive(),
    httpPort: z.int().positive(),
    diskBytes: z.int().positive(),
    cpu: CpuSchema,
    egress: EgressSchema,

    // the names of the secrets granted to it; a value never leaves its host
    grants: z.array(z.string()).readonly(),

    // a template copy whose first boot has not reset its identity yet
    isIdentityResetPending: z.boolean(),
  })
  .readonly();

// a stream's checkpoint, as its place in `checkpoints`, or null for the disk
const StreamStepSchema = z
  .object({
    checkpoint: z.int().nonnegative().nullable(),
    dataset: z.int().nonnegative(),
    base: z.int().nonnegative().nullable(),
  })
  .readonly();

// A box imp's resolved address, which the target's set lets in for the
// seconds it has left
const HeldAnswerSchema = z
  .object({
    names: z.array(z.string()).readonly(),
    address: z.string(),
    ttlS: z.int().positive(),
  })
  .readonly();

const WarmSchema = z
  .object({
    move: WarmMoveSchema,

    // the snapshot's record, which the target writes last, and vm.json
    meta: SnapshotMetaSchema,
    vm: VmIdentitySchema.nullable(),

    // whether the system drive the snapshot reopens follows the disk
    isDriveIncluded: z.boolean(),
    answers: z.array(HeldAnswerSchema).readonly(),
  })
  .readonly();

// What the target needs to rebuild the imp, as a backup manifest holds it:
// no slot or address (the target gives new ones), no secret values
export const MoveHeaderSchema = z
  .object({
    version: z.literal(1),
    imp: ImpSchema,
    image: z.object({
      name: z.string(),
      ref: z.string(),
      digest: z.string(),
      sizeBytes: z.int().nonnegative(),

      // a template, and the imp it came from, as a backup keeps them
      source: ImageSourceSchema,
      sourceImp: z.string().nullable(),

      // false: the target said it has the digest, so no image files follow
      isIncluded: z.boolean(),
    }),

    // oldest first, as the files follow
    checkpoints: z.array(CheckpointSchema).readonly(),

    // ZFS to ZFS: the streams that follow in place of the checkpoint and
    // disk files, in order (docs/architecture/moves.md#zfs-to-zfs)
    streams: z.array(StreamStepSchema).readonly().nullable(),

    // a warm move: the memory snapshot's files follow the disk
    // (docs/architecture/moves.md#warm-moves); null for a cold one
    warm: WarmSchema.nullable().default(null),
  })
  .readonly();

export type MoveHeader = z.infer<typeof MoveHeaderSchema>;

// `/move/offer`: which of the source's parts the target lacks; a warm move
// names the system drive its snapshot reopens
export const MoveOfferSchema = z.object({
  imageDigest: z.string(),
  systemDrive: z.string().optional(),
});

export const MoveOfferReplySchema = z.object({
  needsImage: z.boolean(),
  needsSystemDrive: z.boolean().default(false),
  storage: z.enum(['xfs', 'zfs']),
});

// `/move/commit` and `/move/abort`: whether the target's copy is live
export const MoveCommitReplySchema = z.object({ isCommitted: z.boolean() });

// a receive's part number, from 0, and the empty POST that ends the stream
export const MOVE_PART_HEADER = 'x-imp-move-part';
export const MOVE_FINISH_HEADER = 'x-imp-move-finish';

// the paths under a host's API URL
export const MOVE_PATHS = {
  offer: '/move/offer',
  receive: '/move/receive',
  commit: '/move/commit',
  abort: '/move/abort',
} as const;
