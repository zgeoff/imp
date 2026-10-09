import { faker } from '@faker-js/faker';
import type { ImpDiskUsage } from '../storage/storage-backend';

// One imp's count from a usage pass: an exact count, with arbitrary bytes.
export function buildMockImpDiskUsage(overrides: Partial<ImpDiskUsage> = {}): ImpDiskUsage {
  return {
    exclusiveBytes: faker.number.int({ max: 2 ** 40 }),
    sharedBytes: faker.number.int({ max: 2 ** 40 }),
    isUpperBound: false,
    ...overrides,
  };
}
