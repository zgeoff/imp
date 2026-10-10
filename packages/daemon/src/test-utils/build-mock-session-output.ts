import { faker } from '@faker-js/faker';
import type { SessionOutput } from '@imp/api';

type OffsetsOutput = Extract<SessionOutput, { continuity: 'offsets' }>;

// A session's place in its output from an agent with offsets: a fresh attach
// with no prelude, whose data starts at the end of what was written. Its
// optional parts are absent until an override sets them.
export function buildMockSessionOutput(overrides: Partial<OffsetsOutput> = {}): OffsetsOutput {
  // the offset follows an overridden end, unless an override sets it too
  const end = overrides.end ?? faker.number.int({ min: 0, max: 1_000_000 });

  return {
    continuity: 'offsets',
    bootId: faker.string.uuid(),
    executionGeneration: faker.string.hexadecimal({ length: 32, casing: 'lower', prefix: '' }),
    bufferStart: 0,
    end,
    offset: end,
    prelude: 0,
    coldBoots: [],
    ...overrides,
  };
}
