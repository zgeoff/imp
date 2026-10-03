import { expect, test } from 'bun:test';
import * as z from 'zod';
import { ImpEventDetailSchema } from './event-schema';

const SLEPT_DETAIL = {
  trigger: 'RAM over budget',
  durationMs: 900,
  prepareMs: 240,
  steps: { pause: 1, snapshot: 700 },
};

test('a slept detail carries prepareMs', () => {
  expect(ImpEventDetailSchema.parse(SLEPT_DETAIL).prepareMs).toBe(240);
});

test('a client built before prepareMs still parses a detail that has it', () => {
  // ImpEventDetailSchema as it was before prepareMs
  const OldDetailSchema = z
    .object({
      durationMs: z.int().nonnegative().optional(),
      trigger: z.string().optional(),
      coldBootReason: z.string().optional(),
      steps: z.record(z.string(), z.int()).readonly().optional(),
      released: z.int().positive().optional(),
    })
    .readonly();

  expect(OldDetailSchema.parse(SLEPT_DETAIL)).toEqual({
    trigger: 'RAM over budget',
    durationMs: 900,
    steps: { pause: 1, snapshot: 700 },
  });
});
