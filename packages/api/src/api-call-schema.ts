import * as z from 'zod';
import { NameSchema } from './name-schema';

// who made an API call: a bearer token (CLI, SDK, MCP), the dashboard's
// session cookie or exec ticket, an ssh login, or a tailnet identity
export const ApiActorSchema = z.enum(['token', 'dashboard', 'ssh', 'tailnet']);

export type ApiActor = z.infer<typeof ApiActorSchema>;

// One row of the API audit log: a call that changes something, or an exec,
// console or ssh session opened. Never the call's input: `secrets.add`
// carries a secret's value.
export const ApiCallSchema = z.object({
  at: z.date(),
  procedure: z.string(),
  actor: ApiActorSchema,

  // the token's name, the ssh key's comment or the tailnet login; absent on
  // rows from before named tokens
  actorName: z.string().optional(),

  // the imp the call named; it may be gone since
  imp: NameSchema.optional(),

  // `ok`, or the error code the caller got
  outcome: z.string(),
  durationMs: z.int().nonnegative(),

  // what the call resolved that its name does not show: for `images.add`,
  // the pulled reference by digest, so a `:latest` add is traceable
  detail: z.string().optional(),
});

export type ApiCall = z.infer<typeof ApiCallSchema>;
