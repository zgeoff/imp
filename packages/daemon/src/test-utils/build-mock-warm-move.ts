import { faker } from '@faker-js/faker';
import type { WarmMove } from '@imp/api';

export interface WarmMoveOverrides {
  readonly slot?: number;
  readonly egressMode?: string;
  readonly snapshot?: Partial<WarmMove['snapshot']>;
  readonly host?: Partial<WarmMove['host']>;
}

// A sleeping box imp's side of a warm move (buildWarmMove): its snapshot has
// its CPU and no IPv6, on XFS on the default /16. Versions, the CPU, the slot,
// paths and ports are arbitrary; a nested override merges into its defaults.
export function buildMockWarmMove(overrides: WarmMoveOverrides = {}): WarmMove {
  return {
    slot: overrides.slot ?? faker.number.int({ min: 0, max: 4095 }),
    egressMode: overrides.egressMode ?? 'box',
    snapshot: {
      firecrackerVersion: `v${faker.system.semver()}`,
      snapshotVersion: `v${faker.system.semver()}`,
      hostKernel: faker.system.semver(),
      cpuModel: faker.commerce.productName(),
      cpuFlags: faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' }),
      ipv6Prefix: null,
      ...overrides.snapshot,
    },
    host: {
      dataDir: faker.system.directoryPath(),
      storage: 'xfs',
      subnet: '10.66.0.0/16',
      brokerPort: faker.number.int({ min: 1024, max: 65_535 }),
      dns: [faker.internet.ipv4()],
      ...overrides.host,
    },
  };
}
