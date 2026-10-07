import { faker } from '@faker-js/faker';
import type { Imp } from '../imp-schema';

// A running imp as impd's API answers with it: faker for every field whose
// value is arbitrary, and only the fields every impd sends
export function buildMockImp(overrides: Partial<Imp> = {}): Imp {
  return {
    id: faker.string.uuid(),
    name: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/),
    image: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/),
    state: 'running',
    vcpus: faker.number.int({ min: 1, max: 32 }),
    memoryMib: faker.number.int({ min: 128, max: 16_384 }),
    diskMib: faker.number.int({ min: 1024, max: 65_536 }),
    ip: faker.internet.ipv4(),
    slot: faker.number.int({ min: 0, max: 255 }),
    port: faker.number.int({ min: 1, max: 65_535 }),
    httpPort: faker.number.int({ min: 1, max: 65_535 }),
    url: faker.internet.url(),
    createdAt: faker.date.past(),
    lastActiveAt: faker.date.recent(),
    ...overrides,
  };
}
