import { faker } from '@faker-js/faker';
import type { ImageBuildProgress } from '../image-build-protocol';

// A progress event of a streamed image call: a pull that has run for some
// time.
export function buildMockImageBuildProgress(
  overrides: Partial<ImageBuildProgress> = {},
): ImageBuildProgress {
  return {
    type: 'progress',
    phase: 'pull',
    elapsedMs: faker.number.int({ min: 0, max: 3_600_000 }),
    ...overrides,
  };
}
