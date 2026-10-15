import { faker } from '@faker-js/faker';
import type { ImpRow } from './imp-cli';

// An imp as `impz ls --json` lists it, with only the fields every row
// carries; the optional ones come from overrides.
export function buildMockImpRow(overrides: Readonly<Partial<ImpRow>> = {}): ImpRow {
  return {
    id: faker.string.uuid(),
    name: `e2e-${faker.string.alpha({ length: 8, casing: 'lower' })}`,
    image: `e2e-${faker.string.alpha({ length: 6, casing: 'lower' })}`,
    state: 'running',
    vcpus: faker.number.int({ min: 1, max: 8 }),
    memoryMib: faker.number.int({ min: 128, max: 8192 }),
    slot: faker.number.int({ min: 1, max: 254 }),
    ip: faker.internet.ipv4(),
    port: faker.number.int({ min: 8000, max: 8999 }),
    url: faker.internet.url(),
    lastActiveAt: faker.date.recent().toISOString(),
    ...overrides,
  };
}
