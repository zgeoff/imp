import * as z from 'zod';
import { ExecutionGenerationSchema } from './session-output-schema';

// The agent checks the same rule (agent/internal/session).
export const SessionNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,31}$/,
    'must be a lowercase letter or digit followed by up to 31 lowercase letters, digits or hyphens',
  );

// how a session's process ended; code is null when a signal ended it
export const SessionExitSchema = z
  .object({
    code: z.int().nullable(),
    signal: z.string().nullable(),
  })
  .readonly();

// A program on a pty in an imp that outlives its connection: a console to
// detach from and attach to again.
export const SessionSchema = z.object({
  name: SessionNameSchema,
  pid: z.int().positive(),
  argv: z.array(z.string()).readonly(),
  state: z.enum(['running', 'exited']),

  // a client is attached now; always false for a sleeping imp
  attached: z.boolean(),
  cols: z.int().positive(),
  rows: z.int().positive(),

  // the guest clock at the start
  startedAt: z.date(),

  // set once the process exited, until a client attaches and gets it
  exit: SessionExitSchema.optional(),

  // `offsets` when the imp's agent counts output (left out by an older
  // impd, which means `none`); end is a lower bound, as impd last saw it at
  // endObservedAt
  continuity: z.enum(['none', 'offsets']).optional(),
  executionGeneration: ExecutionGenerationSchema.optional(),
  bootId: z.string().optional(),
  end: z.int().nonnegative().optional(),
  endObservedAt: z.date().optional(),

  // impd keeps a log of this session's output (docs/guides/session-logs.md)
  log: z.boolean().optional(),
});

export type Session = z.infer<typeof SessionSchema>;
