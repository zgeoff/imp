import { faker } from '@faker-js/faker';
import type { Imp } from '@imp/api';

type DiskUsage = NonNullable<Imp['diskUsage']>;

// a complete measurement of an imp's disk use on the host
export function buildMockDiskUsage(overrides: Partial<DiskUsage> = {}): DiskUsage {
  return {
    exclusiveBytes: faker.number.int({ min: 0, max: 1024 }) * 1024 * 1024,
    sharedBytes: faker.number.int({ min: 0, max: 1024 }) * 1024 * 1024,
    measuredAt: faker.date.recent(),
    isPartial: false,
    isUpperBound: false,
    ...overrides,
  };
}
