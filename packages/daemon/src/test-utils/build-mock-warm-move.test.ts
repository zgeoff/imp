import { expect, test } from 'bun:test';
import { isIPv4 } from 'node:net';
import { WarmMoveSchema } from '@imp/api';
import { buildMockWarmMove } from './build-mock-warm-move';

test('it builds a default warm move', () => {
  const move = buildMockWarmMove();

  expect(move).toStrictEqual({
    slot: expect.toBeWithin(0, 4096),
    egressMode: 'box',
    snapshot: {
      firecrackerVersion: expect.toSatisfy((version: string) => /^v\d+\.\d+\.\d+$/v.test(version)),
      snapshotVersion: expect.toSatisfy((version: string) => /^v\d+\.\d+\.\d+$/v.test(version)),
      hostKernel: expect.toSatisfy((kernel: string) => /^\d+\.\d+\.\d+$/v.test(kernel)),
      cpuModel: expect.toSatisfy((model: string) => model.length > 0),
      cpuFlags: expect.toSatisfy((flags: string) => /^[0-9a-f]{64}$/v.test(flags)),
      ipv6Prefix: null,
    },
    host: {
      dataDir: expect.toSatisfy((dir: string) => dir.startsWith('/')),
      storage: 'xfs',
      subnet: '10.66.0.0/16',
      brokerPort: expect.toBeWithin(1024, 65_536),
      dns: [expect.toSatisfy(isIPv4)],
    },
  });

  expect(WarmMoveSchema.parse(move)).toStrictEqual(move);
});

test('it applies overrides on top of the defaults', () => {
  const move = buildMockWarmMove({
    slot: 3,
    egressMode: 'open',
    snapshot: {
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: '6.8.0',
      cpuModel: null,
      cpuFlags: null,
      ipv6Prefix: 'fd00::/64',
    },
    host: {
      dataDir: '/var/lib/imp',
      storage: 'zfs',
      subnet: '10.70.0.0/24',
      brokerPort: 7081,
      dns: ['1.1.1.1'],
    },
  });

  expect(move).toStrictEqual({
    slot: 3,
    egressMode: 'open',
    snapshot: {
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: '6.8.0',
      cpuModel: null,
      cpuFlags: null,
      ipv6Prefix: 'fd00::/64',
    },
    host: {
      dataDir: '/var/lib/imp',
      storage: 'zfs',
      subnet: '10.70.0.0/24',
      brokerPort: 7081,
      dns: ['1.1.1.1'],
    },
  });
});

test('it keeps the default fields of a nested object that an override leaves out', () => {
  const move = buildMockWarmMove({ snapshot: { cpuModel: null }, host: { dataDir: '/srv/imp' } });

  expect(move.snapshot).toStrictEqual({
    firecrackerVersion: expect.toSatisfy((version: string) => /^v\d+\.\d+\.\d+$/v.test(version)),
    snapshotVersion: expect.toSatisfy((version: string) => /^v\d+\.\d+\.\d+$/v.test(version)),
    hostKernel: expect.toSatisfy((kernel: string) => /^\d+\.\d+\.\d+$/v.test(kernel)),
    cpuModel: null,
    cpuFlags: expect.toSatisfy((flags: string) => /^[0-9a-f]{64}$/v.test(flags)),
    ipv6Prefix: null,
  });

  expect(move.host).toStrictEqual({
    dataDir: '/srv/imp',
    storage: 'xfs',
    subnet: '10.66.0.0/16',
    brokerPort: expect.toBeWithin(1024, 65_536),
    dns: [expect.toSatisfy(isIPv4)],
  });
});
