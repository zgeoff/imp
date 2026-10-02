import * as z from 'zod';
import { NameSchema } from './name-schema';

// who made an API call: the bearer token (CLI, SDK, MCP), the dashboard's
// session cookie or exec ticket, or an ssh login
export const ApiActorSchema = z.enum(['token', 'dashboard', 'ssh']);

export type ApiActor = z.infer<typeof ApiActorSchema>;

// One row of the API audit log: a call that changes something, or an exec,
// console or ssh session opened. Never the call's input: `secrets.add`
// carries a secret's value.
export const ApiCallSchema = z.object({
  at: z.date(),
  procedure: z.string(),
  actor: ApiActorSchema,

  // the imp the call named; it may be gone since
  imp: NameSchema.optional(),

  // `ok`, or the error code the caller got
  outcome: z.string(),
  durationMs: z.int().nonnegative(),
});

export type ApiCall = z.infer<typeof ApiCallSchema>;
