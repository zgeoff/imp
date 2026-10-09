import { faker } from '@faker-js/faker';
import type { WarmHost } from '@imp/api';

// A host's warm facts (readWarmHost): XFS on the default /16, whose slot
// count follows the subnet. Versions, the CPU, paths and ports are arbitrary.
export function buildMockWarmHost(overrides: Partial<WarmHost> = {}): WarmHost {
  return {
    firecrackerVersion: `v${faker.system.semver()}`,
    snapshotVersion: `v${faker.system.semver()}`,
    hostKernel: faker.system.semver(),
    cpuModel: faker.commerce.productName(),
    cpuFlags: faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' }),
    dataDir: faker.system.directoryPath(),
    storage: 'xfs',
    subnet: '10.66.0.0/16',
    slotCount: 16_384,
    brokerPort: faker.number.int({ min: 1024, max: 65_535 }),
    dns: [faker.internet.ipv4()],
    ...overrides,
  };
}
