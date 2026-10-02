import * as z from 'zod';

// Output continuity for sessions (docs/architecture/daemon.md#output-offsets):
// offsets count a generation's pty output bytes from 0, so a client that
// reconnects resumes from the byte it last saw and learns what it missed.

// one run of a session's process; a sleep and memory wake keeps it, a cold
// boot ends it
export const ExecutionGenerationSchema = z.string().regex(/^[0-9a-f]{32}$/);
const OffsetSchema = z.int().nonnegative();

// why impd booted an imp cold; docs/architecture/daemon.md#output-offsets
// says what each cause means
export const COLD_BOOT_CAUSES = [
  'start',
  'wake_fallback',
  'watchdog',
  'restore',
  'recovery',
  'unknown',
] as const;

export const ColdBootCauseSchema = z.enum(COLD_BOOT_CAUSES);

export type ColdBootCause = z.infer<typeof ColdBootCauseSchema>;

// bootId is the guest's boot_id from that boot
export const ColdBootSchema = z
  .object({
    bootId: z.string(),
    cause: ColdBootCauseSchema,
    at: z.iso.datetime(),
  })
  .readonly();

export type ColdBoot = z.infer<typeof ColdBootSchema>;

// an imp's last cold boots, newest first; a client finds the first one after
// its own bootId to learn what ended its generation
export const ColdBootsSchema = z.array(ColdBootSchema).max(4).readonly();

// the last generation under a session name that ended and left the name in
// this boot; exitCode is null when a signal ended it
export const PreviousGenerationSchema = z
  .object({
    executionGeneration: ExecutionGenerationSchema,
    end: OffsetSchema,
    exitCode: z.int().nullable(),
  })
  .readonly();

export type PreviousGeneration = z.infer<typeof PreviousGenerationSchema>;

export const ResumeFromSchema = z
  .object({
    executionGeneration: ExecutionGenerationSchema,
    offset: OffsetSchema,
  })
  .readonly();

export type ResumeFrom = z.infer<typeof ResumeFromSchema>;

// how a resumeFrom was met: `exact`; `gap`, whose bytes [from, to) are gone;
// `generation_changed`, when the named generation is not the one running and
// the data is this one's from firstOffset
export const ResumeResultSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('exact') }),
    z.object({ kind: z.literal('gap'), from: OffsetSchema, to: OffsetSchema }),
    z.object({
      kind: z.literal('generation_changed'),
      executionGeneration: ExecutionGenerationSchema,
      firstOffset: OffsetSchema,
    }),
  ])
  .readonly();

export type ResumeResult = z.infer<typeof ResumeResultSchema>;

// where a session socket's data stands; `none` for an agent without offsets,
// which replays as before and ignores resumeFrom
export const SessionOutputSchema = z
  .discriminatedUnion('continuity', [
    z.object({ continuity: z.literal('none') }),
    z.object({
      continuity: z.literal('offsets'),
      bootId: z.string(),
      executionGeneration: ExecutionGenerationSchema,

      // the oldest byte a resume can still get, and the offset after the last
      // byte written so far
      bufferStart: OffsetSchema,
      end: OffsetSchema,

      // the offset of the first data byte this socket sends; prelude counts
      // the mode bytes a fresh attach sends before it, which have no offset
      offset: OffsetSchema,
      prelude: OffsetSchema,
      coldBoots: ColdBootsSchema,
      previous: PreviousGenerationSchema.optional(),

      // set only when the request had resumeFrom
      resume: ResumeResultSchema.optional(),
    }),
  ])
  .readonly();

export type SessionOutput = z.infer<typeof SessionOutputSchema>;

// the data of NO_SESSION from an agent with offsets: this boot, the imp's
// cold boots, and the generation that last ran under the name
export const NoSessionDataSchema = z
  .object({
    bootId: z.string(),
    coldBoots: ColdBootsSchema,
    previous: PreviousGenerationSchema.optional(),
  })
  .readonly();

export type NoSessionData = z.infer<typeof NoSessionDataSchema>;

export const InvalidResumeDataSchema = z
  .object({ end: OffsetSchema, bufferStart: OffsetSchema })
  .readonly();

export type InvalidResumeData = z.infer<typeof InvalidResumeDataSchema>;
