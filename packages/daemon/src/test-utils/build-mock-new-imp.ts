import { faker } from '@faker-js/faker';
import type { NewImp } from '../db/imps';

// An imp row as createImp inserts it: a user imp with no optional field set;
// its name, image, shape, slot and address arbitrary.
export function buildMockNewImp(overrides: Partial<NewImp> = {}): NewImp {
  return {
    name: faker.string.alpha({ length: 8, casing: 'lower' }),
    imageId: faker.string.uuid(),
    vcpus: faker.number.int({ min: 1, max: 4 }),
    memoryMib: faker.helpers.arrayElement([256, 512, 1024, 2048]),
    slot: faker.number.int({ min: 0, max: 250 }),
    ip: faker.internet.ipv4(),
    ...overrides,
  };
}
