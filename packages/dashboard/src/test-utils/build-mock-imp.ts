import { faker } from '@faker-js/faker';
import type { Imp } from '@imp/api';

// An imp as impd lists it: a running imp with every optional field left out
export function buildMockImp(overrides: Partial<Imp> = {}): Imp {
  return {
    id: faker.string.uuid(),
    name: faker.string.alpha({ length: 8, casing: 'lower' }),
    image: faker.string.alpha({ length: 6, casing: 'lower' }),
    state: 'running',
    vcpus: faker.number.int({ min: 1, max: 8 }),
    memoryMib: faker.number.int({ min: 1, max: 32 }) * 128,
    diskMib: faker.number.int({ min: 1, max: 64 }) * 1024,
    ip: faker.internet.ipv4(),
    slot: faker.number.int({ min: 0, max: 250 }),
    port: faker.number.int({ min: 20_000, max: 29_999 }),
    httpPort: faker.number.int({ min: 1024, max: 65_535 }),
    url: faker.internet.url(),
    createdAt: faker.date.past(),
    lastActiveAt: faker.date.recent(),
    ...overrides,
  };
}
