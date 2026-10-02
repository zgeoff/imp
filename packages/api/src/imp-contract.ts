import { oc } from '@orpc/contract';
import * as z from 'zod';
import { CheckpointSchema } from './checkpoint-schema';
import { ImageRefSchema } from './image-ref-schema';
import { ImageSchema } from './image-schema';
import { IMP_ERRORS } from './imp-errors';
import { ImpSchema } from './imp-schema';
import { NameSchema } from './name-schema';
import { SystemInfoSchema } from './system-info-schema';

const base = oc.errors(IMP_ERRORS);
const NameInputSchema = z.object({ name: NameSchema });

// a checkpoint is addressed by its id or by its label
const CheckpointRefSchema = z.string().min(1);
const EmptySchema = z.object({});

export const impContract = {
  imps: {
    create: base
      .input(
        z.object({
          name: NameSchema.optional(),
          image: NameSchema.optional(),
          vcpus: z.int().min(1).max(32).optional(),
          memoryMib: z.int().min(128).optional(),

          // the guest port the wake proxy forwards HTTP to (default 8080)
          httpPort: z.int().min(1).max(65_535).optional(),
        }),
      )
      .output(ImpSchema),

    list: base.output(z.array(ImpSchema)),

    get: base.input(NameInputSchema).output(ImpSchema),

    destroy: base.input(NameInputSchema).output(EmptySchema),

    // cold boot of a stopped imp; a running imp is returned as it is
    start: base.input(NameInputSchema).output(ImpSchema),

    // agent shutdown, then SIGKILL after a timeout; memory is lost
    stop: base.input(NameInputSchema).output(ImpSchema),

    sleep: base.input(NameInputSchema).output(ImpSchema),

    wake: base.input(NameInputSchema).output(ImpSchema),

    // seconds = 0 releases a hold
    hold: base
      .input(z.object({ name: NameSchema, seconds: z.int().nonnegative() }))
      .output(ImpSchema),

    url: base
      .input(NameInputSchema)
      .output(z.object({ local: z.url(), tailnet: z.url().nullable() })),

    // disk only: a memory fork would duplicate entropy and IDs across clones
    fork: base
      .input(
        z.object({
          source: NameSchema,
          name: NameSchema,
          checkpoint: CheckpointRefSchema.optional(),
        }),
      )
      .output(ImpSchema),
  },

  checkpoints: {
    create: base
      .input(z.object({ name: NameSchema, label: z.string().min(1).max(64).optional() }))
      .output(CheckpointSchema),

    list: base.input(NameInputSchema).output(z.array(CheckpointSchema)),

    restore: base
      .input(z.object({ name: NameSchema, checkpoint: CheckpointRefSchema }))
      .output(ImpSchema),

    delete: base
      .input(z.object({ name: NameSchema, checkpoint: CheckpointRefSchema }))
      .output(EmptySchema),
  },

  images: {
    list: base.output(z.array(ImageSchema)),

    // from an image ref the host's docker already has or can pull
    add: base
      .input(z.object({ ref: ImageRefSchema, name: NameSchema.optional() }))
      .output(ImageSchema),

    // contextDir is a path on the imp host, handed to `docker build`
    build: base
      .input(
        z.object({
          // absolute, so docker build cannot read it as a flag
          contextDir: z.string().startsWith('/'),
          name: NameSchema,
          dockerfile: z.string().min(1).optional(),
        }),
      )
      .output(ImageSchema),

    delete: base.input(NameInputSchema).output(EmptySchema),
  },

  exec: {
    // a single-use ticket for one `/exec` WebSocket to this imp (exec-protocol)
    ticket: base
      .input(NameInputSchema)
      .output(z.object({ ticket: z.string(), expiresAt: z.date() })),
  },

  system: {
    info: base.output(SystemInfoSchema),
  },
};

export type ImpContract = typeof impContract;
