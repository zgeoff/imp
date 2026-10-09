import { faker } from '@faker-js/faker';
import type { NewImp } from '../db/imps';

// An imp row as createImp inserts it: a user imp with no optional field set;
// its name, image and shape arbitrary. Slot 0 of the default IMP_SUBNET,
// 10.66.0.0/16, has the guest address 10.66.0.2, so the two go together.
export function buildMockNewImp(overrides: Partial<NewImp> = {}): NewImp {
  return {
    name: faker.string.alpha({ length: 8, casing: 'lower' }),
    imageId: faker.string.uuid(),
    vcpus: faker.number.int({ min: 1, max: 4 }),
    memoryMib: faker.helpers.arrayElement([256, 512, 1024, 2048]),
    slot: 0,
    ip: '10.66.0.2',
    ...overrides,
  };
}
