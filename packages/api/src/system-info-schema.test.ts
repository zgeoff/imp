import { expect, test } from 'bun:test';
import { SystemInfoSchema } from './system-info-schema';

test('it accepts the system info of a host with every part turned on', () => {
  const payload = {
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0, ipv6: 2 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: true,
      state: 'Running',
      hostname: 'imp-host',
      ip: '100.64.0.1',
      names: { live: 3, failed: [{ name: 'dev', error: 'quota reached' }] },
    },
    ramSleepingMib: 1024,
    ksm: {
      running: true,
      sharedMib: 100,
      profitMib: -4,
      zeroMib: 10,
      headroomMib: 256,
      unmergeable: 1,
    },
    cpu: { hostCpus: 8, limitsEnforced: true },
    defaults: { memoryMib: 1024, image: 'base' },
    egress: { isEnforced: true },
    public: {
      ip: '203.0.113.7',
      imps: 2,
      records: { isOk: true, error: null, at: new Date('2026-01-02T03:04:05.000Z') },
    },
    https: {
      domain: 'imps.example.com',
      dnsToken: {
        isOk: false,
        error: 'cannot read /etc/imp/dns-token',
        at: new Date('2026-01-02T03:04:05.000Z'),
      },
    },
    features: {
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
    },
  } as const;

  const result = SystemInfoSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('it accepts the system info of an impd from before the optional parts', () => {
  const payload = {
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  } as const;

  const result = SystemInfoSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('it accepts a null ksm, public and https', () => {
  const payload = {
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
    ksm: null,
    public: null,
    https: null,
  } as const;

  const result = SystemInfoSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('it rejects a negative RAM budget', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: -1,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['ramBudgetMib'] }),
  );
});

test('it rejects a negative used RAM', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: -1,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['ramUsedMib'] }),
  );
});

test('it rejects a negative reserved RAM', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: -1,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['ramReservedMib'] }),
  );
});

test('it rejects a negative committed RAM', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: -1,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['ramCommittedMib'] }),
  );
});

test('it rejects a negative sleeping RAM', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
    ramSleepingMib: -1,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['ramSleepingMib'] }),
  );
});

test('it rejects a fractional awake count', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2.5,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['awakeCount'] }),
  );
});

test('it rejects a negative imp count', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: -1,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['impCount'] }));
});

test('it rejects a negative session count', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: -1,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['sessionCount'] }),
  );
});

test('it rejects a negative cold boot count', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: -1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['bootStatus', 'coldBoots'] }),
  );
});

test('it rejects a negative outdated firecracker count', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: -1, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['bootStatus', 'outdated', 'firecracker'] }),
  );
});

test('it rejects a negative outdated kernel count', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: -1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['bootStatus', 'outdated', 'kernel'] }),
  );
});

test('it rejects a negative outdated agent count', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: -1 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['bootStatus', 'outdated', 'agent'] }),
  );
});

test('it rejects a negative outdated ipv6 count', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0, ipv6: -1 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['bootStatus', 'outdated', 'ipv6'] }),
  );
});

test('it rejects a storage backend outside the list', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'btrfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['storage', 'backend'] }),
  );
});

test('it rejects a negative used storage size', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: -1,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['storage', 'usedBytes'] }),
  );
});

test('it rejects a negative available storage size', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: -1,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['storage', 'availableBytes'] }),
  );
});

test('it rejects a negative reserved storage size', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: -1,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['storage', 'reserveBytes'] }),
  );
});

test('it rejects a negative pending storage size', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: -1,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['storage', 'pendingBytes'] }),
  );
});

test('it rejects a negative imp disk storage size', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: -1,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['storage', 'impDiskBytes'] }),
  );
});

test('it rejects a negative live tailnet name count', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: { live: -1, failed: [{ name: 'dev', error: 'quota reached' }] },
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['tailscale', 'names', 'live'] }),
  );
});

test('it rejects a failed tailnet name that is not an imp name', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: { live: 3, failed: [{ name: 'Dev', error: 'quota reached' }] },
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['tailscale', 'names', 'failed', 0, 'name'] }),
  );
});

test('it rejects a negative KSM shared size', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
    ksm: {
      running: true,
      sharedMib: -1,
      profitMib: -4,
      zeroMib: 10,
      headroomMib: 256,
      unmergeable: 1,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['ksm', 'sharedMib'] }),
  );
});

test('it rejects a negative KSM zero page size', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
    ksm: {
      running: true,
      sharedMib: 100,
      profitMib: -4,
      zeroMib: -1,
      headroomMib: 256,
      unmergeable: 1,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['ksm', 'zeroMib'] }),
  );
});

test('it rejects a negative KSM headroom', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
    ksm: {
      running: true,
      sharedMib: 100,
      profitMib: -4,
      zeroMib: 10,
      headroomMib: -1,
      unmergeable: 1,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['ksm', 'headroomMib'] }),
  );
});

test('it rejects a negative unmergeable imp count', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
    ksm: {
      running: true,
      sharedMib: 100,
      profitMib: -4,
      zeroMib: 10,
      headroomMib: 256,
      unmergeable: -1,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['ksm', 'unmergeable'] }),
  );
});

test('it rejects a fractional KSM profit', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
    ksm: {
      running: true,
      sharedMib: 100,
      profitMib: -4.5,
      zeroMib: 10,
      headroomMib: 256,
      unmergeable: 1,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['ksm', 'profitMib'] }),
  );
});

test('it rejects zero host CPUs', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
    cpu: { hostCpus: 0, limitsEnforced: true },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['cpu', 'hostCpus'] }),
  );
});

test('it rejects a default memory of zero', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
    defaults: { memoryMib: 0, image: 'base' },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['defaults', 'memoryMib'] }),
  );
});

test('it rejects a public IP that is not IPv4', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
    public: {
      ip: '2001:db8::7',
      imps: 2,
      records: { isOk: true, error: null, at: new Date('2026-01-02T03:04:05.000Z') },
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['public', 'ip'] }),
  );
});

test('it rejects a negative public imp count', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
    public: {
      ip: '203.0.113.7',
      imps: -1,
      records: { isOk: true, error: null, at: new Date('2026-01-02T03:04:05.000Z') },
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['public', 'imps'] }),
  );
});

test('it rejects a records pass time that is not a date', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
    public: {
      ip: '203.0.113.7',
      imps: 2,
      records: { isOk: true, error: null, at: '2026-01-02T03:04:05.000Z' },
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['public', 'records', 'at'] }),
  );
});

test('it rejects a DNS token read time that is not a date', () => {
  const result = SystemInfoSchema.safeParse({
    version: '0.40.0',
    ramBudgetMib: 8192,
    ramUsedMib: 2048,
    ramReservedMib: 256,
    ramCommittedMib: 3072,
    awakeCount: 2,
    impCount: 5,
    sessionCount: 3,
    bootStatus: {
      coldBoots: 1,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    firecrackerVersion: '1.12.0',
    guestKernel: { version: '6.1.102', sha256: 'abc123' },
    systemDrive: { sha256: 'def456' },
    storage: {
      backend: 'xfs',
      usedBytes: 1_000_000,
      availableBytes: 9_000_000,
      reserveBytes: 500_000,
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: 20_000_000,
    },
    tailscale: {
      enabled: false,
      state: null,
      hostname: null,
      ip: null,
      names: null,
    },
    https: {
      domain: 'imps.example.com',
      dnsToken: { isOk: true, error: null, at: '2026-01-02T03:04:05.000Z' },
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['https', 'dnsToken', 'at'] }),
  );
});
