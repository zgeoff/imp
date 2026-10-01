import * as z from 'zod';
import { defineErrors } from './define-errors';
import { ImpStateSchema } from './imp-schema';

const ResourceKindSchema = z.enum(['imp', 'image', 'checkpoint']);

const ResourceDataSchema = z.object({
  kind: ResourceKindSchema,
  name: z.string(),
});

// Every control procedure can raise any of these, so the contract attaches
// them once at its base rather than per procedure.
export const IMP_ERRORS = defineErrors({
  NOT_FOUND: { message: 'Not found', data: ResourceDataSchema },
  CONFLICT: { message: 'Already exists', data: ResourceDataSchema },
  RAM_BUDGET_EXCEEDED: {
    message: 'Not enough RAM budget, even after sleeping idle imps',
    status: 503,
    data: z.object({
      budgetMib: z.int().nonnegative(),
      usedMib: z.int().nonnegative(),
      requestedMib: z.int().nonnegative(),
    }),
  },
  INVALID_STATE: {
    message: 'The imp is not in a state that allows this',
    status: 409,
    data: z.object({
      state: ImpStateSchema,
      allowed: z.array(ImpStateSchema),
    }),
  },
});
