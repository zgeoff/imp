import { expect, test } from 'bun:test';
import * as z from 'zod';
import { ImpEventDetailSchema } from './event-schema';

test('it keeps prepareMs in a slept detail', () => {
  const result = ImpEventDetailSchema.safeParse({
    trigger: 'RAM over budget',
    durationMs: 900,
    prepareMs: 240,
    steps: { pause: 1, snapshot: 700 },
  });

  expect(result.data).toStrictEqual({
    trigger: 'RAM over budget',
    durationMs: 900,
    prepareMs: 240,
    steps: { pause: 1, snapshot: 700 },
  });
});

test('it rejects a negative prepareMs', () => {
  const result = ImpEventDetailSchema.safeParse({
    trigger: 'RAM over budget',
    durationMs: 900,
    prepareMs: -1,
    steps: { pause: 1, snapshot: 700 },
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['prepareMs'] }));
});

test('it parses a detail with prepareMs through the schema a client had before prepareMs', () => {
  // ImpEventDetailSchema as it was before prepareMs
  const oldDetailSchema = z
    .object({
      durationMs: z.int().nonnegative().optional(),
      trigger: z.string().optional(),
      coldBootReason: z.string().optional(),
      steps: z.record(z.string(), z.int()).readonly().optional(),
      released: z.int().positive().optional(),
    })
    .readonly();

  const result = oldDetailSchema.safeParse({
    trigger: 'RAM over budget',
    durationMs: 900,
    prepareMs: 240,
    steps: { pause: 1, snapshot: 700 },
  });

  expect(result.data).toStrictEqual({
    trigger: 'RAM over budget',
    durationMs: 900,
    steps: { pause: 1, snapshot: 700 },
  });
});
