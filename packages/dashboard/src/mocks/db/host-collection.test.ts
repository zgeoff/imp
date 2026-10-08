import { expect, test } from 'bun:test';
import { hostCollection } from './host-collection';

test('it creates a default host on XFS, off the tailnet, on impd defaults', async () => {
  const host: Record<string, unknown> = await hostCollection.create({});

  expect(host).toStrictEqual({
    version: expect.toSatisfy((value: string) => /^\d+\.\d+\.\d+$/.test(value)),
    ramBudgetMib: expect.toSatisfy((mib: number) => mib >= 4096 && mib % 1024 === 0),
    ramReservedMib: 0,
    firecrackerVersion: expect.toSatisfy((value: string) => /^v\d+\.\d+\.\d+$/.test(value)),
    guestKernel: {
      version: null,
      sha256: expect.toSatisfy((value: string) => /^[0-9a-fA-F]{64}$/.test(value)),
    },
    systemDrive: { sha256: expect.toSatisfy((value: string) => /^[0-9a-fA-F]{64}$/.test(value)) },
    backend: 'xfs',
    disk: {
      usedBytes: expect.toBeNumber(),
      availableBytes: expect.toBeNumber(),
      reserveBytes: expect.toBeNumber(),
      pendingBytes: 0,
      isLow: false,
    },
    tailscale: { enabled: false, state: null, hostname: null, ip: null, names: null },
    cpu: { hostCpus: expect.toBeWithin(2, 65), limitsEnforced: true },
    defaultImage: 'base',
    defaultMemoryMib: 2048,
    defaultVcpus: 2,
    isEgressEnforced: true,
    ksm: null,
    publicIp: null,
    publicRecords: null,
    https: null,
  });
});

test('it applies overrides on top of the defaults, nested objects whole', async () => {
  const host: Record<string, unknown> = await hostCollection.create({
    ramBudgetMib: 4096,
    backend: 'zfs',
    disk: {
      usedBytes: 1024,
      availableBytes: 2048,
      reserveBytes: 512,
      pendingBytes: 0,
      isLow: true,
    },
    tailscale: { enabled: true, state: 'Running', hostname: 'box', ip: '100.64.0.1', names: null },
    cpu: { hostCpus: 4, limitsEnforced: false },
    publicIp: '203.0.113.7',
  });

  expect(host).toStrictEqual({
    version: expect.toBeString(),
    ramBudgetMib: 4096,
    ramReservedMib: 0,
    firecrackerVersion: expect.toBeString(),
    guestKernel: { version: null, sha256: expect.toBeString() },
    systemDrive: { sha256: expect.toBeString() },
    backend: 'zfs',
    disk: {
      usedBytes: 1024,
      availableBytes: 2048,
      reserveBytes: 512,
      pendingBytes: 0,
      isLow: true,
    },
    tailscale: { enabled: true, state: 'Running', hostname: 'box', ip: '100.64.0.1', names: null },
    cpu: { hostCpus: 4, limitsEnforced: false },
    defaultImage: 'base',
    defaultMemoryMib: 2048,
    defaultVcpus: 2,
    isEgressEnforced: true,
    ksm: null,
    publicIp: '203.0.113.7',
    publicRecords: null,
    https: null,
  });
});
