import { faker } from '@faker-js/faker';
import type { GenerationMeta } from '../session-logs/generation-log';

// One generation's log meta as impd writes it for a live log that holds no
// segment yet. The session, generation, boot and start are arbitrary; the
// end, exit and stop are absent until an override sets them.
export function buildMockGenerationMeta(overrides: Partial<GenerationMeta> = {}): GenerationMeta {
  return {
    version: 1,
    session: faker.string.alpha({ length: 8, casing: 'lower' }),
    executionGeneration: faker.string.hexadecimal({ length: 32, casing: 'lower', prefix: '' }),
    bootId: faker.string.uuid(),
    startedAt: faker.date.past().getTime(),
    origin: 0,
    segments: [],
    state: 'live',
    ...overrides,
  };
}
