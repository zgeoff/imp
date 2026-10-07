import { faker } from '@faker-js/faker';
import type { Imp } from '../imp-schema';

type Nested<T> = T extends Date | readonly unknown[] | null ? T : T extends object ? Partial<T> : T;

type ImpOverrides = { readonly [K in keyof Imp]?: Nested<Exclude<Imp[K], undefined>> };

// A running imp with every field filled. Dates count back from faker's
// reference date, which the preload fixes, so a seed gives the same imp;
// nested overrides merge into their defaults.
export function buildMockImp(overrides: ImpOverrides = {}): Imp {
  const createdAt = faker.date.past();
  const lastActiveAt = faker.date.between({ from: createdAt, to: faker.defaultRefDate() });

  const diskUsage: NonNullable<Imp['diskUsage']> = {
    exclusiveBytes: faker.number.int({ min: 0, max: 2 ** 40 }),
    sharedBytes: faker.number.int({ min: 0, max: 2 ** 40 }),
    measuredAt: lastActiveAt,
    isPartial: false,
    isUpperBound: false,
  };

  const publicExposure: NonNullable<Imp['public']> = { auth: 'token' };
  const leases: NonNullable<Imp['leases']> = { leases: [], otherCount: 0 };
  const cpu: NonNullable<Imp['cpu']> = { limit: null, weight: 100 };

  const resources: NonNullable<Imp['resources']> = {
    wakeCount: faker.number.int({ min: 0, max: 1000 }),
    awakeMs: faker.number.int({ min: 0, max: 86_400_000 }),
  };

  // keys in the order impd encodes them, so the JSON text of an imp matches;
  // an override keeps its key's place
  const defaults: Imp = {
    id: faker.string.uuid(),
    name: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/),
    image: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/),
    state: 'running',
    kind: 'user',
    vcpus: faker.number.int({ min: 1, max: 32 }),
    memoryMib: faker.number.int({ min: 128, max: 16_384 }),
    maxMemoryMib: faker.number.int({ min: 16_384, max: 65_536 }),
    pluggedMib: faker.number.int({ min: 0, max: 4096 }),
    diskMib: faker.number.int({ min: 1024, max: 65_536 }),
    diskUsage,
    ip: faker.internet.ipv4(),
    slot: faker.number.int({ min: 0, max: 255 }),
    port: faker.number.int({ min: 1, max: 65_535 }),
    httpPort: faker.number.int({ min: 1, max: 65_535 }),
    url: faker.internet.url(),
    public: publicExposure,
    createdAt,
    lastActiveAt,
    ramMib: faker.number.int({ min: 0, max: 16_384 }),
    rssMib: faker.number.int({ min: 0, max: 16_384 }),
    sleptAt: createdAt,
    holdUntil: faker.date.soon({ refDate: lastActiveAt }),
    leases,
    error: faker.lorem.sentence(),
    sessions: faker.number.int({ min: 0, max: 8 }),
    coldBootReason: faker.lorem.sentence(),
    agentSilentSince: lastActiveAt,
    outdated: [],
    cpu,
    resources,
    move: 'sending',
  };

  return {
    ...defaults,
    ...overrides,
    diskUsage: { ...diskUsage, ...overrides.diskUsage },
    public: { ...publicExposure, ...overrides.public },
    leases: { ...leases, ...overrides.leases },
    cpu: { ...cpu, ...overrides.cpu },
    resources: { ...resources, ...overrides.resources },
  };
}
