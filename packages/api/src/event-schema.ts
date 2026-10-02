import * as z from 'zod';
import { CheckpointSchema } from './checkpoint-schema';
import { ImpSchema } from './imp-schema';
import { NameSchema } from './name-schema';

// Every event line carries it; a reader ignores fields it does not know.
export const EVENT_VERSION = 1;

// why an imp's record changed (docs/guides/events.md)
export const ImpChangeReasonSchema = z.enum([
  'booted',
  'woke',
  'slept',
  'stopped',
  'failed',

  // impd found the VM or the snapshot gone and corrected the record
  'repaired',

  // impd started and found the imp's VM still running
  'adopted',
  'held',
  'restored',

  // its disk size, or a grow the guest still owes
  'resized',

  // its CPU limit, weight or vCPU count changed
  'updated',

  // made public or tailnet-only, or given a new credential
  'exposed',
]);

export type ImpChangeReason = z.infer<typeof ImpChangeReasonSchema>;

// what a lifecycle step took, where it says
export const ImpEventDetailSchema = z
  .object({
    durationMs: z.int().nonnegative().optional(),

    // what asked for it: `requested`, `idle`, the governor's reason, …
    trigger: z.string().optional(),
    coldBootReason: z.string().optional(),

    // milliseconds per step, as impd logs them
    steps: z.record(z.string(), z.int()).readonly().optional(),
  })
  .readonly();

export type ImpEventDetail = z.infer<typeof ImpEventDetailSchema>;

const envelope = { v: z.literal(EVENT_VERSION), at: z.date() };

export const ImpEventSchema = z.discriminatedUnion('ev', [
  // first every imp as the stream opens (`snapshot`), then each new one
  z.object({
    ...envelope,
    ev: z.literal('ImpAdded'),
    reason: z.enum(['snapshot', 'created']),
    imp: ImpSchema,
  }),
  z.object({
    ...envelope,
    ev: z.literal('ImpChanged'),
    reason: ImpChangeReasonSchema,
    imp: ImpSchema,
    detail: ImpEventDetailSchema.optional(),
  }),

  // the imp as it was last
  z.object({ ...envelope, ev: z.literal('ImpRemoved'), imp: ImpSchema }),
  z.object({
    ...envelope,
    ev: z.literal('CheckpointAdded'),
    name: NameSchema,
    checkpoint: CheckpointSchema,
  }),
  z.object({
    ...envelope,
    ev: z.literal('CheckpointRemoved'),
    name: NameSchema,
    checkpoint: CheckpointSchema,
  }),

  // the RAM governor admitted or refused a boot or wake, or slept an imp
  z.object({
    ...envelope,
    ev: z.literal('GovernorDecision'),
    decision: z.enum(['admitted', 'refused', 'slept']),
    name: NameSchema,
    trigger: z.string(),
    usedMib: z.int().nonnegative(),
    budgetMib: z.int().positive(),
    reserveMib: z.int().nonnegative().optional(),
  }),
]);

export type ImpEvent = z.infer<typeof ImpEventSchema>;
