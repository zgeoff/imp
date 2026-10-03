import * as z from 'zod';
import { NameSchema } from './name-schema';
import { ExecutionGenerationSchema } from './session-output-schema';
import { SessionNameSchema } from './session-schema';

// Session logs (docs/guides/session-logs.md): the output of a session
// started with `log`, kept on the host per generation, read with the ring's
// offsets and gap rules.

const OffsetSchema = z.int().nonnegative();

// the most one read returns; a client reads on from the offset after it
export const SESSION_LOG_READ_MAX_BYTES = 1_048_576;

// one generation's log
export const SessionLogSchema = z
  .object({
    session: SessionNameSchema,
    executionGeneration: ExecutionGenerationSchema,

    // the boot that ran the generation
    bootId: z.string(),

    // `live` while the generation runs; `ended` once it exited, or its VM
    // stopped, or a cold boot ended it
    state: z.enum(['live', 'ended']),

    // the oldest byte the log holds, and the offset after its last; a log
    // can have holes in between, where impd's tap fell behind the ring
    logStart: OffsetSchema,
    logEnd: OffsetSchema,

    // the bytes the log holds
    bytes: OffsetSchema,

    // once ended with an exit that impd saw: the generation's final end and
    // its exit code, null when a signal ended it
    end: OffsetSchema.optional(),
    exitCode: z.int().nullable().optional(),

    // the log holds every byte of a generation that ended with an exit
    complete: z.boolean(),

    // logging stopped early: the host's disk reached its reserve, or the
    // imp's logs reached their bound (IMP_SESSION_LOG_IMP_MAX_MIB)
    stopped: z.enum(['disk_full', 'imp_limit']).optional(),
    startedAt: z.date(),
    endedAt: z.date().optional(),
  })
  .readonly();

export type SessionLog = z.infer<typeof SessionLogSchema>;

export const SessionLogListInputSchema = z.object({
  name: NameSchema,
  session: SessionNameSchema.optional(),
});

export const SessionLogReadInputSchema = z.object({
  name: NameSchema,
  session: SessionNameSchema,
  executionGeneration: ExecutionGenerationSchema,
  from: OffsetSchema,
  limit: z.int().min(1).max(SESSION_LOG_READ_MAX_BYTES).optional(),
});

// `gap` is set when the log no longer holds the bytes [from, offset); the
// data then starts at offset, which can be inside an escape sequence. data is
// raw pty output, and empty at the log's end.
export const SessionLogReadSchema = z
  .object({
    offset: OffsetSchema,
    gap: z.object({ from: OffsetSchema, to: OffsetSchema }).readonly().optional(),
    data: z.instanceof(Blob),
    log: SessionLogSchema,
  })
  .readonly();

export type SessionLogRead = z.infer<typeof SessionLogReadSchema>;

// without executionGeneration every generation of the session goes, and
// without session every log of the imp
export const SessionLogDeleteInputSchema = z
  .object({
    name: NameSchema,
    session: SessionNameSchema.optional(),
    executionGeneration: ExecutionGenerationSchema.optional(),
  })
  .refine((input) => input.executionGeneration === undefined || input.session !== undefined, {
    message: 'a generation is named with its session',
    path: ['executionGeneration'],
  });
