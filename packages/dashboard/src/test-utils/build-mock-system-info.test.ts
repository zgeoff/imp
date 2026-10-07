import { expect, test } from 'bun:test';
import { buildMockSystemInfo } from './build-mock-system-info';

test('it builds a default system info', () => {
  expect(buildMockSystemInfo()).toStrictEqual({
    version: expect.toSatisfy((value: string) => /^\d+\.\d+\.\d+$/.test(value)),
    ramBudgetMib: expect.toSatisfy((mib: number) => mib >= 4096 && mib % 1024 === 0),
    ramUsedMib: expect.toBeWithin(0, 4097),
    ramReservedMib: expect.toBeWithin(0, 1025),
    ramCommittedMib: expect.toBeWithin(0, 8193),
    awakeCount: expect.toBeWithin(0, 11),
    impCount: expect.toBeWithin(0, 21),
    sessionCount: expect.toBeWithin(0, 11),
    firecrackerVersion: expect.toSatisfy((value: string) => /^v\d+\.\d+\.\d+$/.test(value)),
    guestKernel: {
      version: null,
      sha256: expect.toSatisfy((value: string) => /^[0-9a-fA-F]{64}$/.test(value)),
    },
    systemDrive: { sha256: expect.toSatisfy((value: string) => /^[0-9a-fA-F]{64}$/.test(value)) },
    bootStatus: { coldBoots: 0, outdated: { firecracker: 0, kernel: 0, agent: 0 } },
    storage: {
      backend: 'xfs',
      usedBytes: expect.toBeNumber(),
      availableBytes: expect.toBeNumber(),
      reserveBytes: expect.toBeNumber(),
      pendingBytes: 0,
      isLow: false,
      impDiskBytes: expect.toBeNumber(),
    },
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },
  });
});

test('it applies overrides on top of the defaults', () => {
  const info = buildMockSystemInfo({
    ramBudgetMib: 4096,
    storage: { isLow: true },
    tailscale: { enabled: true },
  });

  expect(info).toStrictEqual({
    version: expect.toBeString(),
    ramBudgetMib: 4096,
    ramUsedMib: expect.toBeNumber(),
    ramReservedMib: expect.toBeNumber(),
    ramCommittedMib: expect.toBeNumber(),
    awakeCount: expect.toBeNumber(),
    impCount: expect.toBeNumber(),
    sessionCount: expect.toBeNumber(),
    firecrackerVersion: expect.toBeString(),
    guestKernel: { version: null, sha256: expect.toBeString() },
    systemDrive: { sha256: expect.toBeString() },
    bootStatus: { coldBoots: 0, outdated: { firecracker: 0, kernel: 0, agent: 0 } },
    storage: {
      backend: 'xfs',
      usedBytes: expect.toBeNumber(),
      availableBytes: expect.toBeNumber(),
      reserveBytes: expect.toBeNumber(),
      pendingBytes: 0,
      isLow: true,
      impDiskBytes: expect.toBeNumber(),
    },
    tailscale: { enabled: true, state: null, hostname: null, ip: null, names: null },
  });
});
