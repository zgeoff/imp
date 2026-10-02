import * as z from 'zod';
import { defineErrors } from './define-errors';
import { ImpStateSchema } from './imp-schema';

const ResourceKindSchema = z.enum(['imp', 'image', 'checkpoint', 'session', 'secret', 'grant']);

const ResourceDataSchema = z.object({
  kind: ResourceKindSchema,
  name: z.string(),
});

// Every control procedure can raise any of these, so the contract attaches
// them once at its base rather than per procedure.
export const IMP_ERRORS = defineErrors({
  NOT_FOUND: { message: 'Not found', data: ResourceDataSchema },
  CONFLICT: { message: 'Already exists', data: ResourceDataSchema },

  // an exec ticket used for another imp
  FORBIDDEN: { message: 'Not allowed' },
  RAM_BUDGET_EXCEEDED: {
    message: 'Not enough RAM budget, even after sleeping idle imps',
    status: 503,
    data: z.object({
      budgetMib: z.int().nonnegative(),
      usedMib: z.int().nonnegative(),
      requestedMib: z.int().nonnegative(),
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
    }),
  },

  // the imp's agent is from before the feature; a stop and start updates it
  AGENT_OUTDATED: { message: "The imp's agent is too old for this", status: 409 },
});
