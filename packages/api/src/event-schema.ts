import * as z from 'zod';
import { ApiActorSchema } from './api-call-schema';
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

  // a forced sleep or stop ended its leases (docs/guides/leases.md)
  'released',
]);

export type ImpChangeReason = z.infer<typeof ImpChangeReasonSchema>;

// what a lifecycle step took, where it says
export const ImpEventDetailSchema = z
  .object({
    durationMs: z.int().nonnegative().optional(),

    // `slept`: the work before `durationMs` (disk room, a young guest's wait,
    // the shrink), so the sleep started at `at` less both
    prepareMs: z.int().nonnegative().optional(),

    // what asked for it: `requested`, `idle`, the governor's reason, …
    trigger: z.string().optional(),
    coldBootReason: z.string().optional(),

    // milliseconds per step, as impd logs them
    steps: z.record(z.string(), z.int()).readonly().optional(),

    // `released`: how many leases a forced sleep or stop ended
    released: z.int().positive().optional(),
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

    // `refused`: the RAM still missing, and how many awake imps it could
    // not sleep; never their names, which not every reader may see
    neededMib: z.int().nonnegative().optional(),
    protectedCount: z.int().nonnegative().optional(),
  }),

  // the agent took a command to run in its own world, outside the imp's
  // container (`imp exec --agent`): who ran it, and the program, never
  // its arguments
  z.object({
    ...envelope,
    ev: z.literal('AgentExec'),
    name: NameSchema,
    actor: ApiActorSchema,
    actorName: z.string(),
    tty: z.boolean(),
    command: z.string(),
  }),
]);

export type ImpEvent = z.infer<typeof ImpEventSchema>;
