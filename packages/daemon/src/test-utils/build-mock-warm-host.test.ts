import { expect, test } from 'bun:test';
import { isIPv4 } from 'node:net';
import { WarmHostSchema } from '@imp/api';
import { buildMockWarmHost } from './build-mock-warm-host';

test('it builds a default warm host', () => {
  const host = buildMockWarmHost();

  expect(host).toStrictEqual({
    firecrackerVersion: expect.toSatisfy((version: string) => /^v\d+\.\d+\.\d+$/v.test(version)),
    snapshotVersion: expect.toSatisfy((version: string) => /^v\d+\.\d+\.\d+$/v.test(version)),
    hostKernel: expect.toSatisfy((kernel: string) => /^\d+\.\d+\.\d+$/v.test(kernel)),
    cpuModel: expect.toSatisfy((model: string) => model.length > 0),
    cpuFlags: expect.toSatisfy((flags: string) => /^[0-9a-f]{64}$/v.test(flags)),
    dataDir: expect.toSatisfy((dir: string) => dir.startsWith('/')),
    storage: 'xfs',
    subnet: '10.66.0.0/16',
    slotCount: 16_384,
    brokerPort: expect.toBeWithin(1024, 65_536),
    dns: [expect.toSatisfy(isIPv4)],
  });

  expect(WarmHostSchema.parse(host)).toStrictEqual(host);
});

test('it applies overrides on top of the defaults', () => {
  const host = buildMockWarmHost({
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.8.0',
    cpuModel: 'AMD EPYC 9454P',
    cpuFlags: 'flags-sha',
    dataDir: '/var/lib/imp',
    storage: 'zfs',
    subnet: '10.70.0.0/24',
    slotCount: 64,
    brokerPort: 7081,
    dns: ['1.1.1.1', '8.8.8.8'],
  });

  expect(host).toStrictEqual({
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.8.0',
    cpuModel: 'AMD EPYC 9454P',
    cpuFlags: 'flags-sha',
    dataDir: '/var/lib/imp',
    storage: 'zfs',
    subnet: '10.70.0.0/24',
    slotCount: 64,
    brokerPort: 7081,
    dns: ['1.1.1.1', '8.8.8.8'],
  });
});
