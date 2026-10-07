import { faker } from '@faker-js/faker';
import type { Imp } from '@imp/api';

type ImpResources = NonNullable<Imp['resources']>;

type ResourceSample = NonNullable<ImpResources['sample']>;

interface ImpResourcesOverrides extends Partial<Omit<ImpResources, 'sample'>> {
  readonly sample?: Partial<ResourceSample>;
}

// what a running imp used, with impd's last sample of its VM
export function buildMockImpResources(overrides: ImpResourcesOverrides = {}): ImpResources {
  const since = faker.date.recent();

  return {
    wakeCount: overrides.wakeCount ?? faker.number.int({ min: 0, max: 100 }),
    awakeMs: overrides.awakeMs ?? faker.number.int({ min: 0, max: 86_400_000 }),
    sample: {
      measuredAt: faker.date.soon({ refDate: since }),
      since,
      cpuPercent: faker.number.float({ min: 0, max: 200, fractionDigits: 1 }),
      cpuThrottledMs: faker.number.int({ min: 0, max: 60_000 }),
      netRxBytes: faker.number.int({ min: 0, max: 1024 * 1024 }),
      netTxBytes: faker.number.int({ min: 0, max: 1024 * 1024 }),
      ...overrides.sample,
    },
  };
}
