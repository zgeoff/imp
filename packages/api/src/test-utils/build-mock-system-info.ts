import { faker } from '@faker-js/faker';
import type { SystemInfo } from '../system-info-schema';

// the parts an override merges into their defaults; every other key replaces
type MergedKey =
  | 'bootStatus'
  | 'guestKernel'
  | 'systemDrive'
  | 'storage'
  | 'tailscale'
  | 'cpu'
  | 'defaults'
  | 'egress'
  | 'features';

type SystemInfoOverrides = {
  readonly [K in keyof SystemInfo]?: K extends MergedKey
    ? Partial<NonNullable<SystemInfo[K]>>
    : Exclude<SystemInfo[K], undefined>;
};

// A current impd's answer with every optional part present: all features on,
// egress enforced, storage not low, KSM, public IP and HTTPS off, and a RAM
// budget that fits the default memory. Nested overrides merge into defaults.
export function buildMockSystemInfo(overrides: SystemInfoOverrides = {}): SystemInfo {
  const bootStatus: SystemInfo['bootStatus'] = {
    coldBoots: 0,
    outdated: { firecracker: 0, kernel: 0, agent: 0, ipv6: 0 },
  };

  const guestKernel: SystemInfo['guestKernel'] = {
    version: faker.system.semver(),
    sha256: faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' }),
  };

  const systemDrive: SystemInfo['systemDrive'] = {
    sha256: faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' }),
  };

  const storage: SystemInfo['storage'] = {
    backend: 'xfs',
    usedBytes: faker.number.int({ min: 0, max: 2 ** 40 }),
    availableBytes: faker.number.int({ min: 2 ** 34, max: 2 ** 42 }),
    reserveBytes: faker.number.int({ min: 0, max: 2 ** 33 }),
    pendingBytes: faker.number.int({ min: 0, max: 2 ** 30 }),
    isLow: false,
    impDiskBytes: faker.number.int({ min: 0, max: 2 ** 42 }),
  };

  const tailscale: SystemInfo['tailscale'] = {
    enabled: false,
    state: null,
    hostname: null,
    ip: null,
    names: null,
  };

  const cpu: NonNullable<SystemInfo['cpu']> = {
    hostCpus: faker.number.int({ min: 1, max: 64 }),
    limitsEnforced: true,
  };

  const defaults: NonNullable<SystemInfo['defaults']> = {
    memoryMib: faker.number.int({ min: 128, max: 4096 }),
    image: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/),
  };

  const egress: NonNullable<SystemInfo['egress']> = { isEnforced: true };

  const features: NonNullable<SystemInfo['features']> = {
    sessionOffsets: true,
    leases: true,
    grantableTokens: true,
    secretRebind: true,
    tokenUpdate: true,
    databaseCopy: true,
    imageBuildStream: true,
    imageOpStream: true,
    execRequire: true,
    oauthGrants: true,
    secretFilesGc: true,
    sessionLog: true,
    publicEgress: true,
    oauthSecrets: true,
    secretUpstream: true,
  };

  const defaultsInfo: SystemInfo = {
    version: faker.system.semver(),
    ramBudgetMib: faker.number.int({ min: 4096, max: 65_536 }),
    ramUsedMib: faker.number.int({ min: 0, max: 4096 }),
    ramReservedMib: faker.number.int({ min: 0, max: 1024 }),
    ramCommittedMib: faker.number.int({ min: 0, max: 8192 }),
    ramSleepingMib: faker.number.int({ min: 0, max: 8192 }),
    awakeCount: faker.number.int({ min: 0, max: 30 }),
    impCount: faker.number.int({ min: 0, max: 60 }),
    sessionCount: faker.number.int({ min: 0, max: 60 }),
    bootStatus,
    firecrackerVersion: `v${faker.system.semver()}`,
    guestKernel,
    systemDrive,
    storage,
    tailscale,
    ksm: null,
    cpu,
    defaults,
    egress,
    public: null,
    https: null,
    features,
  };

  return {
    ...defaultsInfo,
    ...overrides,
    bootStatus: { ...bootStatus, ...overrides.bootStatus },
    guestKernel: { ...guestKernel, ...overrides.guestKernel },
    systemDrive: { ...systemDrive, ...overrides.systemDrive },
    storage: { ...storage, ...overrides.storage },
    tailscale: { ...tailscale, ...overrides.tailscale },
    cpu: { ...cpu, ...overrides.cpu },
    defaults: { ...defaults, ...overrides.defaults },
    egress: { ...egress, ...overrides.egress },
    features: { ...features, ...overrides.features },
  };
}
