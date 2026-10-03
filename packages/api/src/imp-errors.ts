import * as z from 'zod';
import { defineErrors } from './define-errors';
import { ImpStateSchema } from './imp-schema';
import { LeaseSummarySchema } from './lease-schema';
import { NameSchema } from './name-schema';
import { ColdBootsSchema, InvalidResumeDataSchema } from './session-output-schema';

const ResourceKindSchema = z.enum([
  'imp',
  'image',
  'checkpoint',
  'session',
  'service',
  'secret',
  'grant',
  'backup',
  'token',
  'ssh-key',
  'network',
  'database-copy',
]);

const ResourceDataSchema = z.object({
  kind: ResourceKindSchema,
  name: z.string(),

  // a secrets.add replace whose kind or rules changed, without rebind
  reason: z.enum(['binding_changed']).optional(),
});

// why a grant or a revoke was refused: the imp is outside the caller's
// patterns, the secret is not one it may grant, or its scope is too low
const ForbiddenReasonSchema = z.enum(['imp_out_of_scope', 'not_grantable', 'scope']);

export type ForbiddenReason = z.infer<typeof ForbiddenReasonSchema>;

const ForbiddenDataSchema = z.object({ reason: ForbiddenReasonSchema });

// an awake imp the governor could not sleep: leased (a lease of any kind)
// or busy (in use, under an operation, or its sleep failed)
const ProtectedImpSchema = z.object({
  name: NameSchema,
  ramMib: z.int().nonnegative(),
  leased: z.boolean(),
  busy: z.boolean(),
});

// Every control procedure can raise any of these, so the contract attaches
// them once at its base rather than per procedure.
export const IMP_ERRORS = defineErrors({
  NOT_FOUND: { message: 'Not found', data: ResourceDataSchema },
  CONFLICT: { message: 'Already exists', data: ResourceDataSchema },

  // the caller's token lacks the scope, or the imp is outside its patterns;
  // a grant or a revoke says which (docs/guides/tokens.md#granting-secrets)
  FORBIDDEN: { message: 'Not allowed', data: ForbiddenDataSchema.optional() },

  // the host is not set up for this, such as backups with no repository
  PRECONDITION_FAILED: { message: 'Not possible on this host' },
  RAM_BUDGET_EXCEEDED: {
    message: 'Not enough RAM budget, even after sleeping idle imps',
    status: 503,
    data: z.object({
      budgetMib: z.int().nonnegative(),
      usedMib: z.int().nonnegative(),
      requestedMib: z.int().nonnegative(),

      // left out by an impd from before leases: the RAM still missing, the
      // awake imps the governor could not sleep that the caller may read,
      // and how many others there were
      neededMib: z.int().nonnegative().optional(),
      protected: z.array(ProtectedImpSchema).readonly().optional(),
      protectedHidden: z.int().nonnegative().optional(),
    }),
  },

  // impd is putting every imp to sleep to stop; try again once it is back
  SERVICE_UNAVAILABLE: { message: 'impd is stopping' },
  INVALID_STATE: {
    message: 'The imp is not in a state that allows this',
    status: 409,
    data: z.object({
      state: ImpStateSchema,
      allowed: z.array(ImpStateSchema),

      // an attach with wake: false to an imp that is not running: its cold
      // boots, absent while it is creating
      coldBoots: ColdBootsSchema.optional(),
    }),
  },

  // a session resume named an offset past the end of its generation, which
  // never rewinds: a client bug, not a state to clamp
  INVALID_RESUME: {
    message: 'The resume offset is past the end of the output',
    status: 409,
    data: InvalidResumeDataSchema,
  },

  // the data filesystem or pool would drop below its reserve (IMP_DISK_RESERVE_GIB)
  DISK_FULL: {
    message: 'Not enough free disk on the host',
    status: 507,
    data: z.object({
      availableBytes: z.int().nonnegative(),
      reserveBytes: z.int().nonnegative(),
      requestedBytes: z.int().nonnegative(),
    }),
  },

  // a sleep or stop without force on an imp with a lease from `leases.*`
  LEASED: {
    message: 'The imp is leased',
    status: 409,
    data: LeaseSummarySchema,
  },

  // a renew of a lease the caller does not hold, or that ended
  LEASE_NOT_HELD: { message: 'The caller holds no such lease', status: 409 },

  // the imp's agent is from before the feature; a stop and start updates it
  AGENT_OUTDATED: { message: "The imp's agent is too old for this", status: 409 },

  // the imp is moving to or from another host; try again after retryAfterS
  MOVING: {
    message: 'The imp is moving between hosts',
    status: 409,
    data: z.object({ retryAfterS: z.int().positive() }),
  },
});
