import { expect, test } from 'bun:test';
import type { SystemInfo } from '@imp/api';
import { systemInfoCollection } from './system-info-collection';

test('it creates a default host on XFS, off the tailnet, with nothing to boot cold', async () => {
  const info: SystemInfo = await systemInfoCollection.create({});

  expect(info).toStrictEqual({
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

test('it applies overrides on top of the defaults', async () => {
  const info = await systemInfoCollection.create({ ramBudgetMib: 4096, ramUsedMib: 1024 });

  expect(info).toMatchObject({ ramBudgetMib: 4096, ramUsedMib: 1024 });
});
