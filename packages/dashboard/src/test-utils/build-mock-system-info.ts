import { faker } from '@faker-js/faker';
import type { SystemInfo } from '@imp/api';

interface SystemInfoOverrides extends Partial<
  Omit<SystemInfo, 'bootStatus' | 'storage' | 'tailscale'>
> {
  readonly bootStatus?: Partial<SystemInfo['bootStatus']>;
  readonly storage?: Partial<SystemInfo['storage']>;
  readonly tailscale?: Partial<SystemInfo['tailscale']>;
}

// what system.info says of a host on XFS, off the tailnet, with nothing to
// boot cold
export function buildMockSystemInfo(overrides: SystemInfoOverrides = {}): SystemInfo {
  const { bootStatus, storage, tailscale, ...rest } = overrides;

  return {
    version: faker.system.semver(),
    ramBudgetMib: faker.number.int({ min: 4, max: 64 }) * 1024,
    ramUsedMib: faker.number.int({ min: 0, max: 4096 }),
    ramReservedMib: faker.number.int({ min: 0, max: 1024 }),
    ramCommittedMib: faker.number.int({ min: 0, max: 8192 }),
    awakeCount: faker.number.int({ min: 0, max: 10 }),
    impCount: faker.number.int({ min: 0, max: 20 }),
    sessionCount: faker.number.int({ min: 0, max: 10 }),
    firecrackerVersion: `v${faker.system.semver()}`,
    guestKernel: { version: null, sha256: faker.string.hexadecimal({ length: 64, prefix: '' }) },
    systemDrive: { sha256: faker.string.hexadecimal({ length: 64, prefix: '' }) },
    ...rest,
    bootStatus: {
      coldBoots: 0,
      outdated: { firecracker: 0, kernel: 0, agent: 0 },
      ...bootStatus,
    },
    storage: {
      backend: 'xfs',
      usedBytes: faker.number.int({ min: 0, max: 1024 ** 4 }),
      availableBytes: faker.number.int({ min: 0, max: 1024 ** 4 }),
      reserveBytes: faker.number.int({ min: 0, max: 1024 ** 3 }),
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: faker.number.int({ min: 0, max: 1024 ** 4 }),
      ...storage,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
      ...tailscale,
    },
  };
}
