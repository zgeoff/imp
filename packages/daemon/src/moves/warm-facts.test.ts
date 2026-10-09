import { expect, test } from 'bun:test';
import { parseSubnet } from '../net/addressing';
import { buildMockWarmHost } from '../test-utils/build-mock-warm-host';
import { buildMockWarmMove } from '../test-utils/build-mock-warm-move';
import { buildWarmMove, findWarmMismatches, readWarmHost } from './warm-facts';

test('#readWarmHost reports the identity, the config and the storage a warm move needs', () => {
  const host = readWarmHost(
    {
      dataDir: '/var/lib/imp',
      subnet: parseSubnet('10.66.0.0/24'),
      brokerPort: 7081,
      dns: ['1.1.1.1', '8.8.8.8'],
    },
    {
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: '6.8.0',
      guestKernel: 'a'.repeat(64),
      systemDrive: 'b'.repeat(64),
      systemDrivePath: '/var/lib/imp/system/drives/bb.ext4',
      ipv6Prefix: null,
      cpuModel: 'AMD EPYC 9454P',
      cpuFlags: 'flags-sha',
    },
    'zfs',
  );

  expect(host).toStrictEqual({
    firecrackerVersion: 'v1.17.0',
    snapshotVersion: 'v12.0.0',
    hostKernel: '6.8.0',
    cpuModel: 'AMD EPYC 9454P',
    cpuFlags: 'flags-sha',
    dataDir: '/var/lib/imp',
    storage: 'zfs',
    subnet: '10.66.0.0/24',

    // a /24 holds 256 addresses, four to a slot
    slotCount: 64,
    brokerPort: 7081,
    dns: ['1.1.1.1', '8.8.8.8'],
  });
});

test('#buildWarmMove takes the snapshot facts from the snapshot and the host facts from the host', () => {
  const move = buildWarmMove(
    3,
    'open',
    {
      firecrackerVersion: 'v1.16.0',
      snapshotVersion: 'v11.0.0',
      hostKernel: '6.6.0',
      guestKernel: 'a'.repeat(64),
      systemDrive: 'b'.repeat(64),
      cpuModel: 'AMD EPYC 7763',
      cpuFlags: 'old-flags',
      ipv6Prefix: 'fd00::/64',
      createdAt: 1_700_000_000_000,
      memoryMib: 512,
      ramMib: 512,
    },
    {
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: '6.8.0',
      cpuModel: 'AMD EPYC 9454P',
      cpuFlags: 'flags-sha',
      dataDir: '/var/lib/imp',
      storage: 'xfs',
      subnet: '10.66.0.0/16',
      slotCount: 16_384,
      brokerPort: 7081,
      dns: ['1.1.1.1'],
    },
  );

  expect(move).toStrictEqual({
    slot: 3,
    egressMode: 'open',
    snapshot: {
      firecrackerVersion: 'v1.16.0',
      snapshotVersion: 'v11.0.0',
      hostKernel: '6.6.0',
      cpuModel: 'AMD EPYC 7763',
      cpuFlags: 'old-flags',
      ipv6Prefix: 'fd00::/64',
    },
    host: {
      dataDir: '/var/lib/imp',
      storage: 'xfs',
      subnet: '10.66.0.0/16',
      brokerPort: 7081,
      dns: ['1.1.1.1'],
    },
  });
});

test('#buildWarmMove records a snapshot from an older impd without its CPU or IPv6 as null', () => {
  const move = buildWarmMove(
    0,
    'box',
    {
      firecrackerVersion: 'v1.16.0',
      snapshotVersion: 'v11.0.0',
      hostKernel: '6.6.0',
      guestKernel: 'a'.repeat(64),
      systemDrive: 'b'.repeat(64),
      createdAt: 1_700_000_000_000,
      memoryMib: 512,
      ramMib: 512,
    },
    buildMockWarmHost(),
  );

  expect(move.snapshot).toStrictEqual({
    firecrackerVersion: 'v1.16.0',
    snapshotVersion: 'v11.0.0',
    hostKernel: '6.6.0',
    cpuModel: null,
    cpuFlags: null,
    ipv6Prefix: null,
  });
});

test('#findWarmMismatches finds nothing when the target shares every fact of an open imp', () => {
  const target = buildMockWarmHost();

  const move = buildMockWarmMove({
    slot: 0,
    egressMode: 'open',
    snapshot: {
      firecrackerVersion: target.firecrackerVersion,
      snapshotVersion: target.snapshotVersion,
      hostKernel: target.hostKernel,
      cpuModel: target.cpuModel,
      cpuFlags: target.cpuFlags,
    },
    host: {
      dataDir: target.dataDir,
      storage: target.storage,
      subnet: target.subnet,
      brokerPort: target.brokerPort,
      dns: target.dns,
    },
  });

  expect(findWarmMismatches(move, target)).toStrictEqual([]);
});

test.each([
  [
    'the Firecracker version',
    { firecrackerVersion: 'v1.16.0' },
    {},
    { firecrackerVersion: 'v1.17.0' },
    ['the Firecracker version differs (v1.16.0 here, v1.17.0 there)'],
  ],
  [
    'the snapshot format',
    { snapshotVersion: 'v11.0.0' },
    {},
    { snapshotVersion: 'v12.0.0' },
    ['the snapshot format differs (v11.0.0 here, v12.0.0 there)'],
  ],
  [
    'the host kernel',
    { hostKernel: '6.6.0' },
    {},
    { hostKernel: '6.8.0' },
    ['the host kernel differs (6.6.0 here, 6.8.0 there)'],
  ],
  [
    'the CPU model',
    { cpuModel: 'AMD EPYC 7763' },
    {},
    { cpuModel: 'AMD EPYC 9454P' },
    ['the CPU differs (AMD EPYC 7763 here, AMD EPYC 9454P there)'],
  ],
  [
    'the CPU flags',
    { cpuFlags: 'old-flags' },
    {},
    { cpuFlags: 'new-flags' },
    ['the CPU flags differ'],
  ],
  ['an unknown source CPU', { cpuFlags: 'unknown' }, {}, {}, ['a CPU is unknown']],
  ['an unknown target CPU', {}, {}, { cpuFlags: 'unknown' }, ['a CPU is unknown']],
  [
    'a snapshot without its CPU model',
    { cpuModel: null },
    {},
    {},
    ['the snapshot does not record its CPU (it is from an older impd)'],
  ],
  [
    'a snapshot without its CPU flags',
    { cpuFlags: null },
    {},
    {},
    ['the snapshot does not record its CPU (it is from an older impd)'],
  ],
  [
    'an IPv6 address',
    { ipv6Prefix: 'fd00::/64' },
    {},
    {},
    ["the imp has an IPv6 address in fd00::/64, this host's prefix"],
  ],
  [
    'IMP_DATA_DIR',
    {},
    { dataDir: '/var/lib/imp' },
    { dataDir: '/srv/imp' },
    ['IMP_DATA_DIR differs (/var/lib/imp here, /srv/imp there)'],
  ],
  [
    'the storage backend',
    {},
    { storage: 'xfs' as const },
    { storage: 'zfs' as const },
    ['the storage backend differs (xfs here, zfs there)'],
  ],
  [
    'IMP_SUBNET',
    {},
    { subnet: '10.66.0.0/16' },
    { subnet: '10.70.0.0/16' },
    ['IMP_SUBNET differs (10.66.0.0/16 here, 10.70.0.0/16 there)'],
  ],
  [
    'IMP_BROKER_PORT',
    {},
    { brokerPort: 7081 },
    { brokerPort: 7082 },
    ['IMP_BROKER_PORT differs (7081 here, 7082 there)'],
  ],
  [
    'IMP_DNS',
    {},
    { dns: ['1.1.1.1', '8.8.8.8'] },
    { dns: ['9.9.9.9'] },
    ['IMP_DNS differs (1.1.1.1,8.8.8.8 here, 9.9.9.9 there)'],
  ],
])(
  '#findWarmMismatches refuses an open imp whose target differs in %s',
  (_fact, snapshot, moveHost, targetOverrides, expected) => {
    const base = buildMockWarmHost();
    const target = { ...base, ...targetOverrides };

    const move = buildMockWarmMove({
      slot: 0,
      egressMode: 'open',
      snapshot: {
        firecrackerVersion: base.firecrackerVersion,
        snapshotVersion: base.snapshotVersion,
        hostKernel: base.hostKernel,
        cpuModel: base.cpuModel,
        cpuFlags: base.cpuFlags,
        ...snapshot,
      },
      host: {
        dataDir: base.dataDir,
        storage: base.storage,
        subnet: base.subnet,
        brokerPort: base.brokerPort,
        dns: base.dns,
        ...moveHost,
      },
    });

    expect(findWarmMismatches(move, target)).toStrictEqual(expected);
  },
);

test('#findWarmMismatches ignores IMP_DNS for a box imp, which asks the host resolver', () => {
  const target = buildMockWarmHost({ dns: ['9.9.9.9'] });

  const move = buildMockWarmMove({
    slot: 0,
    egressMode: 'box',
    snapshot: {
      firecrackerVersion: target.firecrackerVersion,
      snapshotVersion: target.snapshotVersion,
      hostKernel: target.hostKernel,
      cpuModel: target.cpuModel,
      cpuFlags: target.cpuFlags,
    },
    host: {
      dataDir: target.dataDir,
      storage: target.storage,
      subnet: target.subnet,
      brokerPort: target.brokerPort,
      dns: ['1.1.1.1', '8.8.8.8'],
    },
  });

  expect(findWarmMismatches(move, target)).toStrictEqual([]);
});

test('#findWarmMismatches refuses a slot past the target slot count', () => {
  const target = buildMockWarmHost({ slotCount: 16 });

  const move = buildMockWarmMove({
    slot: 16,
    snapshot: {
      firecrackerVersion: target.firecrackerVersion,
      snapshotVersion: target.snapshotVersion,
      hostKernel: target.hostKernel,
      cpuModel: target.cpuModel,
      cpuFlags: target.cpuFlags,
    },
    host: {
      dataDir: target.dataDir,
      storage: target.storage,
      subnet: target.subnet,
      brokerPort: target.brokerPort,
      dns: target.dns,
    },
  });

  expect(findWarmMismatches(move, target)).toStrictEqual(["slot 16 is past the target's 16 slots"]);
});

test('#findWarmMismatches reports every fact that differs, in order', () => {
  const target = buildMockWarmHost({ slotCount: 16 });

  const move = buildMockWarmMove({
    slot: 20,
    snapshot: {
      firecrackerVersion: target.firecrackerVersion,
      snapshotVersion: target.snapshotVersion,
      hostKernel: target.hostKernel,
      cpuModel: null,
      cpuFlags: target.cpuFlags,
      ipv6Prefix: 'fd00::/64',
    },
    host: {
      dataDir: target.dataDir,
      storage: target.storage,
      subnet: target.subnet,
      brokerPort: target.brokerPort,
      dns: target.dns,
    },
  });

  expect(findWarmMismatches(move, target)).toStrictEqual([
    'the snapshot does not record its CPU (it is from an older impd)',
    "the imp has an IPv6 address in fd00::/64, this host's prefix",
    "slot 20 is past the target's 16 slots",
  ]);
});
