import { expect, test } from 'bun:test';
import {
  COLD_BOOT_CAUSES,
  ColdBootCauseSchema,
  ColdBootSchema,
  ColdBootsSchema,
  ExecutionGenerationSchema,
  InvalidResumeDataSchema,
  NoSessionDataSchema,
  PreviousGenerationSchema,
  ResumeFromSchema,
  ResumeResultSchema,
  SessionOutputSchema,
} from './session-output-schema';

test('#ExecutionGenerationSchema accepts 32 lowercase hex digits', () => {
  expect(ExecutionGenerationSchema.safeParse('0123456789abcdef0123456789abcdef').data).toBe(
    '0123456789abcdef0123456789abcdef',
  );
});

test.each([
  '',
  '0123456789abcdef0123456789abcde',
  '0123456789abcdef0123456789abcdef0',
  '0123456789ABCDEF0123456789ABCDEF',
  '0123456789abcdef0123456789abcdeg',
])('#ExecutionGenerationSchema rejects the generation %p', (generation) => {
  const result = ExecutionGenerationSchema.safeParse(generation);

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_format' });
});

test.each(['start', 'wake_fallback', 'watchdog', 'restore', 'recovery', 'unknown'])(
  '#ColdBootCauseSchema accepts the cause %s',
  (cause) => {
    expect(ColdBootCauseSchema.safeParse(cause).data).toBe(cause);
  },
);

test('#COLD_BOOT_CAUSES lists every cause a client may meet, in order', () => {
  expect(COLD_BOOT_CAUSES).toStrictEqual([
    'start',
    'wake_fallback',
    'watchdog',
    'restore',
    'recovery',
    'unknown',
  ]);
});

test('#ColdBootCauseSchema rejects a cause outside the list', () => {
  const result = ColdBootCauseSchema.safeParse('crash');

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_value' });
});

test('#ColdBootSchema accepts a cold boot', () => {
  const payload = { bootId: 'boot-1', cause: 'watchdog', at: '2026-01-02T03:04:05.000Z' } as const;

  expect(ColdBootSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ColdBootSchema rejects a cause outside the list', () => {
  const result = ColdBootSchema.safeParse({
    bootId: 'boot-1',
    cause: 'crash',
    at: '2026-01-02T03:04:05.000Z',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['cause'], code: 'invalid_value' });
});

test('#ColdBootSchema rejects a time that is not an ISO datetime', () => {
  const result = ColdBootSchema.safeParse({
    bootId: 'boot-1',
    cause: 'watchdog',
    at: 'yesterday',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['at'], code: 'invalid_format' });
});

test('#ColdBootsSchema accepts four cold boots', () => {
  const payload = [
    { bootId: 'boot-4', cause: 'start', at: '2026-01-04T00:00:00.000Z' },
    { bootId: 'boot-3', cause: 'restore', at: '2026-01-03T00:00:00.000Z' },
    { bootId: 'boot-2', cause: 'recovery', at: '2026-01-02T00:00:00.000Z' },
    { bootId: 'boot-1', cause: 'unknown', at: '2026-01-01T00:00:00.000Z' },
  ] as const;

  const result = ColdBootsSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ColdBootsSchema rejects more than four cold boots', () => {
  const result = ColdBootsSchema.safeParse([
    { bootId: 'boot-5', cause: 'start', at: '2026-01-05T00:00:00.000Z' },
    { bootId: 'boot-4', cause: 'start', at: '2026-01-04T00:00:00.000Z' },
    { bootId: 'boot-3', cause: 'restore', at: '2026-01-03T00:00:00.000Z' },
    { bootId: 'boot-2', cause: 'recovery', at: '2026-01-02T00:00:00.000Z' },
    { bootId: 'boot-1', cause: 'unknown', at: '2026-01-01T00:00:00.000Z' },
  ]);

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_big' });
});

test('#PreviousGenerationSchema accepts a generation that ended on a signal', () => {
  const payload = {
    executionGeneration: '0123456789abcdef0123456789abcdef',
    end: 2048,
    exitCode: null,
  } as const;

  const result = PreviousGenerationSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#PreviousGenerationSchema rejects a generation that is not 32 hex digits', () => {
  const result = PreviousGenerationSchema.safeParse({
    executionGeneration: 'gen-1',
    end: 2048,
    exitCode: null,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['executionGeneration'],
    code: 'invalid_format',
  });
});

test('#PreviousGenerationSchema rejects a negative end', () => {
  const result = PreviousGenerationSchema.safeParse({
    executionGeneration: '0123456789abcdef0123456789abcdef',
    end: -1,
    exitCode: null,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['end'], code: 'too_small' });
});

test('#PreviousGenerationSchema rejects a fractional exit code', () => {
  const result = PreviousGenerationSchema.safeParse({
    executionGeneration: '0123456789abcdef0123456789abcdef',
    end: 2048,
    exitCode: 0.5,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['exitCode'], code: 'invalid_type' });
});

test('#ResumeFromSchema accepts a generation and an offset', () => {
  const payload = { executionGeneration: '0123456789abcdef0123456789abcdef', offset: 0 } as const;

  expect(ResumeFromSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ResumeFromSchema rejects a generation that is not 32 hex digits', () => {
  const result = ResumeFromSchema.safeParse({ executionGeneration: 'gen-1', offset: 0 });

  expect(result.error?.issues).toPartiallyContain({
    path: ['executionGeneration'],
    code: 'invalid_format',
  });
});

test('#ResumeFromSchema rejects a negative offset', () => {
  const result = ResumeFromSchema.safeParse({
    executionGeneration: '0123456789abcdef0123456789abcdef',
    offset: -1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['offset'], code: 'too_small' });
});

test('#ResumeFromSchema rejects a fractional offset', () => {
  const result = ResumeFromSchema.safeParse({
    executionGeneration: '0123456789abcdef0123456789abcdef',
    offset: 1.5,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['offset'], code: 'invalid_type' });
});

test('#ResumeResultSchema accepts an exact resume', () => {
  expect(ResumeResultSchema.safeParse({ kind: 'exact' }).data).toStrictEqual({ kind: 'exact' });
});

test('#ResumeResultSchema accepts a resume with a gap', () => {
  const payload = { kind: 'gap', from: 10, to: 20 } as const;

  expect(ResumeResultSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ResumeResultSchema accepts a resume into a changed generation', () => {
  const payload = {
    kind: 'generation_changed',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    firstOffset: 0,
  } as const;

  const result = ResumeResultSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#ResumeResultSchema rejects a gap with a negative start', () => {
  const result = ResumeResultSchema.safeParse({ kind: 'gap', from: -1, to: 20 });

  expect(result.error?.issues).toPartiallyContain({ path: ['from'], code: 'too_small' });
});

test('#ResumeResultSchema rejects a gap with a negative end', () => {
  const result = ResumeResultSchema.safeParse({ kind: 'gap', from: 10, to: -1 });

  expect(result.error?.issues).toPartiallyContain({ path: ['to'], code: 'too_small' });
});

test('#ResumeResultSchema rejects a changed generation that is not 32 hex digits', () => {
  const result = ResumeResultSchema.safeParse({
    kind: 'generation_changed',
    executionGeneration: 'gen-2',
    firstOffset: 0,
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['executionGeneration'],
    code: 'invalid_format',
  });
});

test('#ResumeResultSchema rejects a negative first offset', () => {
  const result = ResumeResultSchema.safeParse({
    kind: 'generation_changed',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    firstOffset: -1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['firstOffset'], code: 'too_small' });
});

test('#ResumeResultSchema rejects an unknown kind', () => {
  const result = ResumeResultSchema.safeParse({ kind: 'rewound' });

  expect(result.error?.issues).toPartiallyContain({ path: ['kind'], code: 'invalid_union' });
});

test('#SessionOutputSchema accepts the output of an agent without offsets', () => {
  expect(SessionOutputSchema.safeParse({ continuity: 'none' }).data).toStrictEqual({
    continuity: 'none',
  });
});

test('#SessionOutputSchema accepts the output of an agent with offsets', () => {
  const payload = {
    continuity: 'offsets',
    bootId: 'boot-2',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bufferStart: 0,
    end: 4096,
    offset: 1024,
    prelude: 8,
    coldBoots: [{ bootId: 'boot-2', cause: 'start', at: '2026-01-02T00:00:00.000Z' }],
    previous: {
      executionGeneration: 'fedcba9876543210fedcba9876543210',
      end: 512,
      exitCode: 0,
    },
    resume: { kind: 'exact' },
    log: { enabled: true },
  } as const;

  const result = SessionOutputSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SessionOutputSchema accepts offsets with no previous generation, resume or log', () => {
  const payload = {
    continuity: 'offsets',
    bootId: 'boot-2',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bufferStart: 0,
    end: 4096,
    offset: 1024,
    prelude: 8,
    coldBoots: [],
  } as const;

  const result = SessionOutputSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#SessionOutputSchema rejects an unknown continuity', () => {
  const result = SessionOutputSchema.safeParse({ continuity: 'lines' });

  expect(result.error?.issues).toPartiallyContain({ path: ['continuity'], code: 'invalid_union' });
});

test('#SessionOutputSchema rejects a generation that is not 32 hex digits', () => {
  const result = SessionOutputSchema.safeParse({
    continuity: 'offsets',
    bootId: 'boot-2',
    executionGeneration: 'gen-1',
    bufferStart: 0,
    end: 4096,
    offset: 1024,
    prelude: 8,
    coldBoots: [],
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['executionGeneration'],
    code: 'invalid_format',
  });
});

test('#SessionOutputSchema rejects a negative buffer start', () => {
  const result = SessionOutputSchema.safeParse({
    continuity: 'offsets',
    bootId: 'boot-2',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bufferStart: -1,
    end: 4096,
    offset: 1024,
    prelude: 8,
    coldBoots: [],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['bufferStart'], code: 'too_small' });
});

test('#SessionOutputSchema rejects a negative end', () => {
  const result = SessionOutputSchema.safeParse({
    continuity: 'offsets',
    bootId: 'boot-2',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bufferStart: 0,
    end: -1,
    offset: 1024,
    prelude: 8,
    coldBoots: [],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['end'], code: 'too_small' });
});

test('#SessionOutputSchema rejects a negative offset', () => {
  const result = SessionOutputSchema.safeParse({
    continuity: 'offsets',
    bootId: 'boot-2',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bufferStart: 0,
    end: 4096,
    offset: -1,
    prelude: 8,
    coldBoots: [],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['offset'], code: 'too_small' });
});

test('#SessionOutputSchema rejects a negative prelude', () => {
  const result = SessionOutputSchema.safeParse({
    continuity: 'offsets',
    bootId: 'boot-2',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bufferStart: 0,
    end: 4096,
    offset: 1024,
    prelude: -1,
    coldBoots: [],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['prelude'], code: 'too_small' });
});

test('#SessionOutputSchema rejects a cold boot with an unknown cause', () => {
  const result = SessionOutputSchema.safeParse({
    continuity: 'offsets',
    bootId: 'boot-2',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bufferStart: 0,
    end: 4096,
    offset: 1024,
    prelude: 8,
    coldBoots: [{ bootId: 'boot-2', cause: 'crash', at: '2026-01-02T00:00:00.000Z' }],
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['coldBoots', 0, 'cause'],
    code: 'invalid_value',
  });
});

test('#SessionOutputSchema rejects a resume of an unknown kind', () => {
  const result = SessionOutputSchema.safeParse({
    continuity: 'offsets',
    bootId: 'boot-2',
    executionGeneration: '0123456789abcdef0123456789abcdef',
    bufferStart: 0,
    end: 4096,
    offset: 1024,
    prelude: 8,
    coldBoots: [],
    resume: { kind: 'rewound' },
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['resume', 'kind'],
    code: 'invalid_union',
  });
});

test('#NoSessionDataSchema accepts a boot with its cold boots and previous generation', () => {
  const payload = {
    bootId: 'boot-2',
    coldBoots: [{ bootId: 'boot-2', cause: 'wake_fallback', at: '2026-01-02T00:00:00.000Z' }],
    previous: {
      executionGeneration: '0123456789abcdef0123456789abcdef',
      end: 512,
      exitCode: 1,
    },
  } as const;

  const result = NoSessionDataSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#NoSessionDataSchema rejects a previous generation with a negative end', () => {
  const result = NoSessionDataSchema.safeParse({
    bootId: 'boot-2',
    coldBoots: [{ bootId: 'boot-2', cause: 'wake_fallback', at: '2026-01-02T00:00:00.000Z' }],
    previous: {
      executionGeneration: '0123456789abcdef0123456789abcdef',
      end: -1,
      exitCode: 1,
    },
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['previous', 'end'], code: 'too_small' });
});

test('#InvalidResumeDataSchema accepts an end and a buffer start', () => {
  const payload = { end: 4096, bufferStart: 1024 } as const;

  expect(InvalidResumeDataSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#InvalidResumeDataSchema rejects a negative end', () => {
  const result = InvalidResumeDataSchema.safeParse({ end: -1, bufferStart: 1024 });

  expect(result.error?.issues).toPartiallyContain({ path: ['end'], code: 'too_small' });
});

test('#InvalidResumeDataSchema rejects a negative buffer start', () => {
  const result = InvalidResumeDataSchema.safeParse({ end: 4096, bufferStart: -1 });

  expect(result.error?.issues).toPartiallyContain({ path: ['bufferStart'], code: 'too_small' });
});
