import { faker } from '@faker-js/faker';
import type { ImpRecord } from '../db/imps';

// An imp as the imps table reads it: a running user imp with no lease, no
// move and no pending work; its names, sizes and times arbitrary.
export function buildMockImpRecord(overrides: Partial<ImpRecord> = {}): ImpRecord {
  const memoryMib = faker.number.int({ min: 256, max: 8192 });

  return {
    id: faker.string.uuid(),
    name: faker.string.alphanumeric({ length: 12, casing: 'lower' }),
    imageId: faker.string.uuid(),
    state: 'running',
    kind: 'user',
    vcpus: faker.number.int({ min: 1, max: 8 }),
    memoryMib,
    maxMemoryMib: memoryMib,
    slot: faker.number.int({ min: 0, max: 4095 }),
    ip: faker.internet.ipv4(),
    createdAt: faker.date.past(),
    lastActiveAt: faker.date.recent(),
    sleptAt: null,
    holdUntil: null,
    error: null,
    pid: faker.number.int({ min: 2, max: 4_194_304 }),
    firecrackerVersion: 'v1.17.0',
    httpPort: faker.internet.port(),
    diskBytes: faker.number.int({ min: 1024 ** 3, max: 64 * 1024 ** 3 }),
    isDiskGrowPending: false,
    publicAuth: null,
    cpu: { limit: null, weight: 100 },
    wakeCount: faker.number.int({ min: 0, max: 100 }),
    jailUid: faker.number.int({ min: 900_000, max: 965_535 }),
    awakeMs: faker.number.int({ min: 0, max: 86_400_000 }),
    awakeSince: faker.date.recent(),
    isIdentityResetPending: false,
    isTrustPending: false,
    moveState: null,
    ...overrides,
  };
}
